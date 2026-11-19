import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import personalAgentMigrations from "../src/personal-agent/migrations/migrations.js";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { resetFakes } from "./fakes.ts";
import { addOwner } from "./telegram-requests.ts";

const openLoopMigration = "20261119094927_open_loops";

const migrationsBeforeOpenLoops = Object.fromEntries(
  Object.entries(personalAgentMigrations.migrations).filter(
    ([name]) => name < openLoopMigration
  )
);

const columnsOfNotes = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')")
    .toArray()
    .map((column) => column.name);

beforeEach(() => {
  resetFakes();
});

describe("the Open Loop migration", () => {
  it("keeps every existing Note with no Open Loop and keeps its links and search", async () => {
    const ownerId = await addOwner(9901);
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );

    await runInDurableObject(agent, async (_instance, state) => {
      await Effect.runPromise(
        Effect.gen(function* seedEffect() {
          const { database } = yield* AgentStorage;
          const now = "2026-01-01T00:00:00.000Z";
          for (const [noteId, text] of [
            ["gift", "buy a gift for Ana"],
            ["fact", "Ana likes scarves"],
          ] as const) {
            yield* database.run(
              sql`INSERT INTO notes (note_id, owner_id, text, source_event_id, source_channel, source_conversation_id, source_channel_message_id, trust_level, text_hash, captured_at, last_checked_at) VALUES (${noteId}, ${ownerId}, ${text}, ${`seed-${noteId}`}, 'telegram', '9901', ${noteId}, 'owner', ${`hash-${noteId}`}, ${now}, ${now})`
            );
          }
          yield* database.run(
            sql`INSERT INTO note_links (from_note_id, to_note_id, created_at) VALUES ('fact', 'gift', ${now})`
          );
        }).pipe(
          Effect.provide(
            AgentStorage.layer(state.storage, {
              migrations: migrationsBeforeOpenLoops,
            }).pipe(Layer.orDie)
          )
        )
      );
      expect(columnsOfNotes(state.storage)).not.toContain("open_loop_state");
    });

    const migrated = await runInDurableObject(agent, (instance, state) =>
      instance.runtime
        .runPromise(
          Effect.gen(function* readEffect() {
            const notes = yield* Notes;
            return {
              listed: yield* notes.list,
              found: yield* notes.search({ query: "scarves", limit: 5 }),
              open: yield* notes.listOpenLoops({ offset: 0, limit: 10 }),
            };
          })
        )
        .then((read) => ({ ...read, columns: columnsOfNotes(state.storage) }))
    );

    expect(migrated.columns).toEqual(
      expect.arrayContaining([
        "open_loop_kind",
        "open_loop_state",
        "open_loop_closed_reason",
        "open_loop_due_at",
      ])
    );
    expect(
      migrated.listed.map(({ noteId, openLoop, linkedNoteIds }) => ({
        noteId,
        openLoop,
        linkedNoteIds,
      }))
    ).toEqual([
      { noteId: "fact", openLoop: undefined, linkedNoteIds: ["gift"] },
      { noteId: "gift", openLoop: undefined, linkedNoteIds: ["fact"] },
    ]);
    expect(migrated.found.map((note) => note.noteId)).toEqual(["fact"]);
    expect(migrated.open).toEqual({ notes: [], openLoopCount: 0 });

    const opened = await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Notes.pipe(
          Effect.flatMap((notes) =>
            notes.update({
              noteId: "gift",
              eventId: "after-migration",
              openLoop: { kind: "task" },
            })
          ),
          Effect.map(({ note }) => note.openLoop)
        )
      )
    );
    expect(opened).toEqual({ _tag: "Open", kind: "task" });
  });
});
