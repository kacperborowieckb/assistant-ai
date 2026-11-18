import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import personalAgentMigrations from "../src/personal-agent/migrations/migrations.js";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { fakeTelegram, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const openLoopMigration = "20261118201954_open_loops";

const migrationsBeforeOpenLoops = Object.fromEntries(
  Object.entries(personalAgentMigrations.migrations).filter(
    ([name]) => name < openLoopMigration
  )
);

const seedNotes = (storage: DurableObjectStorage, ownerId: string) =>
  Effect.runPromise(
    Effect.gen(function* seedEffect() {
      const { database } = yield* AgentStorage;
      for (const [noteId, text] of [
        ["note-a", "buy a gift for Ana"],
        ["note-b", "Tom likes Osteria"],
      ] as const) {
        yield* database.run(
          sql`INSERT INTO notes (note_id, owner_id, text, source_event_id, source_channel, source_conversation_id, source_channel_message_id, trust_level, text_hash, captured_at, last_checked_at) VALUES (${noteId}, ${ownerId}, ${text}, ${`event-${noteId}`}, 'telegram', '1', ${noteId}, 'owner', ${`hash-${noteId}`}, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`
        );
      }
      yield* database.run(
        sql`INSERT INTO note_links (from_note_id, to_note_id, created_at) VALUES ('note-a', 'note-b', '2026-01-03T00:00:00.000Z')`
      );
    }).pipe(
      Effect.provide(
        AgentStorage.layer(storage, { migrations: migrationsBeforeOpenLoops })
      )
    )
  );

beforeEach(() => {
  resetFakes();
});

describe("the Open Loop migration", () => {
  it("keeps existing Notes, links, and search, gives them no Open Loop, and lets new Notes have one", async () => {
    const ownerId = await addOwner(9901);
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );

    await runInDurableObject(agent, async (_instance, state) => {
      await Effect.runPromise(
        Effect.void.pipe(
          Effect.provide(
            AgentStorage.layer(state.storage, {
              migrations: migrationsBeforeOpenLoops,
            }).pipe(Layer.orDie)
          )
        )
      );
      const columns = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')")
        .toArray()
        .map((column) => column.name);
      expect(columns).not.toContain("open_loop_state");
      await seedNotes(state.storage, ownerId);
    });

    await telegramWebhook(textUpdate({ fromUserId: 9901, text: "hello" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));

    const migrated = await runInDurableObject(agent, (_instance, state) => ({
      notes: state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT note_id, text, captured_at, last_checked_at, open_loop_kind, open_loop_due_at, open_loop_state, open_loop_close_reason FROM notes ORDER BY note_id"
        )
        .toArray(),
      links: state.storage.sql
        .exec("SELECT from_note_id, to_note_id FROM note_links")
        .toArray(),
      triggers: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'notes' ORDER BY name"
        )
        .toArray()
        .map((trigger) => trigger.name),
    }));
    expect(migrated.notes).toEqual([
      {
        note_id: "note-a",
        text: "buy a gift for Ana",
        captured_at: "2026-01-01T00:00:00.000Z",
        last_checked_at: "2026-01-02T00:00:00.000Z",
        open_loop_kind: null,
        open_loop_due_at: null,
        open_loop_state: null,
        open_loop_close_reason: null,
      },
      {
        note_id: "note-b",
        text: "Tom likes Osteria",
        captured_at: "2026-01-01T00:00:00.000Z",
        last_checked_at: "2026-01-02T00:00:00.000Z",
        open_loop_kind: null,
        open_loop_due_at: null,
        open_loop_state: null,
        open_loop_close_reason: null,
      },
    ]);
    expect(migrated.links).toEqual([
      { from_note_id: "note-a", to_note_id: "note-b" },
    ]);
    expect(migrated.triggers).toEqual([
      "notes_fts_delete",
      "notes_fts_insert",
      "notes_fts_update",
    ]);

    const after = await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* afterEffect() {
          const notes = yield* Notes;
          const found = yield* notes.search({ query: "Osteria", limit: 5 });
          const kept = yield* notes.capture({
            text: "pay the rent",
            source: {
              eventId: "after",
              channel: "telegram",
              conversationId: "1",
              channelMessageId: "after",
              trustLevel: "owner",
            },
            openLoop: { kind: "task" },
          });
          const searched = yield* notes.search({ query: "rent", limit: 5 });
          return { found, kept, searched };
        })
      )
    );
    expect(after.found.map((note) => note.noteId)).toEqual(["note-b"]);
    expect(after.found[0]?.openLoop).toBeUndefined();
    expect(after.kept.note.openLoop?._tag).toBe("Open");
    expect(after.searched.map((note) => note.text)).toEqual(["pay the rent"]);
  });
});
