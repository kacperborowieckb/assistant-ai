import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import type { AgentMigrations } from "../src/personal-agent/agent-storage.ts";
import { Conversation } from "../src/personal-agent/conversation.ts";
import personalAgentMigrations from "../src/personal-agent/migrations/migrations.js";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";

const withNextMigration = (nextSql: string): AgentMigrations => ({
  migrations: {
    ...personalAgentMigrations.migrations,
    "29990101000000_next": nextSql,
  },
});

const freshAgent = (name: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(name));

const columnsOf = (table: string) =>
  Effect.gen(function* columnsOfEffect() {
    const { database } = yield* AgentStorage;
    const columns = yield* database.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info(${table})`
    );
    return columns.map((column) => column.name);
  });

const appendOwnerMessage = Effect.gen(function* appendEffect() {
  const conversation = yield* Conversation;
  yield* conversation.append("seed", [{ role: "user", content: "kept" }]);
});

const readMessages = Effect.gen(function* readEffect() {
  const conversation = yield* Conversation;
  return yield* conversation.recent;
});

const runWithMigrations = <A, E>(
  storage: DurableObjectStorage,
  migrations: AgentMigrations | undefined,
  effect: Effect.Effect<A, E, AgentStorage | Conversation>
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        Conversation.layer.pipe(
          Layer.provideMerge(AgentStorage.layer(storage, migrations))
        )
      )
    )
  );

describe("Personal Agent migrations", () => {
  it("keeps existing rows and applies a later migration once", async () => {
    const agent = await freshAgent("owner-upgrade");

    await runInDurableObject(agent, async (_instance, state) => {
      await runWithMigrations(state.storage, undefined, appendOwnerMessage);

      const upgrade = withNextMigration(
        "ALTER TABLE conversation_messages ADD COLUMN edited_at text;"
      );
      const afterUpgrade = await runWithMigrations(
        state.storage,
        upgrade,
        Effect.zip(readMessages, columnsOf("conversation_messages"))
      );
      const afterSecondStart = await runWithMigrations(
        state.storage,
        upgrade,
        columnsOf("conversation_messages")
      );

      expect(afterUpgrade).toEqual(
        Exit.succeed([
          [{ role: "user", content: "kept" }],
          expect.arrayContaining(["edited_at", "message"]),
        ])
      );
      expect(Exit.isSuccess(afterSecondStart)).toBe(true);
    });
  });

  it("keeps the Inbox rows that existed before the Event union migration", async () => {
    const agent = await freshAgent("owner-before-event-union");
    const eventUnionMigration = "20261116000630_schedule_fired_events";
    const { [eventUnionMigration]: _later, ...earlier } =
      personalAgentMigrations.migrations;

    await runInDurableObject(agent, async (_instance, state) => {
      await runWithMigrations(
        state.storage,
        { migrations: earlier },
        columnsOf("inbox_events")
      );
      state.storage.sql.exec(
        "INSERT INTO inbox_events (event_id, channel, channel_update_id, conversation_id, channel_message_id, text, sent_at, received_at, state) VALUES ('kept-event', 'telegram', '11', '7', '12', 'kept text', '2026-11-15T10:00:00.000Z', '2026-11-15T10:00:01.000Z', 'done')"
      );

      const upgraded = await runWithMigrations(
        state.storage,
        undefined,
        columnsOf("inbox_events")
      );
      const rows = state.storage.sql
        .exec<{
          event_id: string;
          kind: string;
          text: string;
          state: string;
          sequence: number;
        }>("SELECT event_id, kind, text, state, sequence FROM inbox_events")
        .toArray();

      expect(Exit.isSuccess(upgraded)).toBe(true);
      expect(rows).toEqual([
        {
          event_id: "kept-event",
          kind: "OwnerMessage",
          text: "kept text",
          state: "done",
          sequence: 1,
        },
      ]);
    });
  });

  it("leaves no partial schema when a migration fails", async () => {
    const agent = await freshAgent("owner-failed-migration");

    await runInDurableObject(agent, async (_instance, state) => {
      await runWithMigrations(state.storage, undefined, appendOwnerMessage);

      const failing = withNextMigration(
        [
          "ALTER TABLE conversation_messages ADD COLUMN half_done text;",
          "THIS IS NOT SQL;",
        ].join("\n--> statement-breakpoint\n")
      );
      const failedStart = await runWithMigrations(
        state.storage,
        failing,
        readMessages
      );
      const restart = await runWithMigrations(
        state.storage,
        undefined,
        Effect.zip(readMessages, columnsOf("conversation_messages"))
      );

      expect(Exit.isFailure(failedStart)).toBe(true);
      expect(JSON.stringify(failedStart)).toContain("MigrationFailed");
      expect(Exit.isSuccess(restart)).toBe(true);
      if (Exit.isSuccess(restart)) {
        const [messages, columns] = restart.value;
        expect(messages).toEqual([{ role: "user", content: "kept" }]);
        expect(columns).not.toContain("half_done");
      }
    });
  });

  it("creates the triggers that keep the Journal and the Traces append-only and the Note search in step", async () => {
    const agent = await freshAgent("owner-journal-triggers");

    await runInDurableObject(agent, async (_instance, state) => {
      await runWithMigrations(state.storage, undefined, appendOwnerMessage);
      const triggers = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
        )
        .toArray()
        .map((trigger) => trigger.name);

      expect(triggers).toEqual([
        "journal_entries_no_delete",
        "journal_entries_no_update",
        "notes_fts_delete",
        "notes_fts_insert",
        "notes_fts_update",
        "turn_traces_no_delete",
        "turn_traces_no_update",
      ]);
    });
  });
});
