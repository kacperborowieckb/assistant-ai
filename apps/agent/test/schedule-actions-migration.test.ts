import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import personalAgentMigrations from "../src/personal-agent/migrations/migrations.js";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { fakeTelegram, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const actionMigration = "20261116152927_schedule_actions";

const migrationsBeforeActions = Object.fromEntries(
  Object.entries(personalAgentMigrations.migrations).filter(
    ([name]) => name < actionMigration
  )
);

interface SeededReminder {
  readonly scheduleId: string;
  readonly text: string;
  readonly nextDueAt: string;
  readonly recurrence: string | null;
  readonly recurrenceTimeZone: string | null;
  readonly state: "active" | "done" | "cancelled";
}

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  action: string;
  text: string;
  next_due_at: string;
  recurrence: string | null;
  recurrence_time_zone: string | null;
  state: string;
}

const dailyAtNine = JSON.stringify({ _tag: "Daily", time: "09:00" });

const seededReminders = (oneTimeDueAt: string): readonly SeededReminder[] => [
  {
    scheduleId: "one-time",
    text: "Buy the gift",
    nextDueAt: oneTimeDueAt,
    recurrence: null,
    recurrenceTimeZone: null,
    state: "active",
  },
  {
    scheduleId: "repeating",
    text: "Water the plants",
    nextDueAt: "2100-01-01T08:00:00.000Z",
    recurrence: dailyAtNine,
    recurrenceTimeZone: "Europe/Warsaw",
    state: "active",
  },
  {
    scheduleId: "done",
    text: "Call Ana",
    nextDueAt: "2026-01-01T08:00:00.000Z",
    recurrence: null,
    recurrenceTimeZone: null,
    state: "done",
  },
  {
    scheduleId: "cancelled",
    text: "Pay the bill",
    nextDueAt: "2100-02-01T08:00:00.000Z",
    recurrence: null,
    recurrenceTimeZone: null,
    state: "cancelled",
  },
];

const requestKeyOf = ({
  text,
  nextDueAt,
  recurrence,
  recurrenceTimeZone,
}: SeededReminder) =>
  JSON.stringify([
    text,
    null,
    recurrence === null ? [nextDueAt] : [recurrence, recurrenceTimeZone],
  ]);

const seedBeforeActions = (
  storage: DurableObjectStorage,
  ownerId: string,
  reminders: readonly SeededReminder[]
) =>
  Effect.runPromise(
    Effect.gen(function* seedEffect() {
      const { database } = yield* AgentStorage;
      for (const reminder of reminders) {
        yield* database.run(
          sql`INSERT INTO schedules (schedule_id, owner_id, kind, set_by, text, next_due_at, recurrence, recurrence_time_zone, state, source_event_id, request_key, created_at, changed_at) VALUES (${reminder.scheduleId}, ${ownerId}, 'reminder', 'owner', ${reminder.text}, ${reminder.nextDueAt}, ${reminder.recurrence}, ${reminder.recurrenceTimeZone}, ${reminder.state}, ${`source-${reminder.scheduleId}`}, ${requestKeyOf(reminder)}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
        );
      }
    }).pipe(
      Effect.provide(
        AgentStorage.layer(storage, { migrations: migrationsBeforeActions })
      )
    )
  );

const columnsOfSchedules = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('schedules')")
    .toArray()
    .map((column) => column.name);

const rowsOf = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<ScheduleRow>(
      "SELECT schedule_id, action, text, next_due_at, recurrence, recurrence_time_zone, state FROM schedules ORDER BY schedule_id"
    )
    .toArray();

beforeEach(() => {
  resetFakes();
});

describe("the Schedule Action migration", () => {
  it("turns each Reminder into a send_text Schedule with the same text, due time, rule, and state, and sends it as before", async () => {
    const ownerId = await addOwner(9601);
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    const dueLater = DateTime.formatIso(
      DateTime.add(DateTime.nowUnsafe(), { hours: 1 })
    );
    const reminders = seededReminders(dueLater);

    await runInDurableObject(agent, async (_instance, state) => {
      await Effect.runPromise(
        Effect.void.pipe(
          Effect.provide(
            AgentStorage.layer(state.storage, {
              migrations: migrationsBeforeActions,
            }).pipe(Layer.orDie)
          )
        )
      );
      expect(columnsOfSchedules(state.storage)).toContain("kind");
      await seedBeforeActions(state.storage, ownerId, reminders);
    });

    await telegramWebhook(textUpdate({ fromUserId: 9601, text: "hello" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));

    const migrated = await runInDurableObject(agent, (_instance, state) => ({
      columns: columnsOfSchedules(state.storage),
      rows: rowsOf(state.storage),
    }));
    expect(migrated.columns).toContain("action");
    expect(migrated.columns).not.toContain("kind");
    expect(migrated.rows).toEqual(
      [...reminders]
        .toSorted((a, b) => a.scheduleId.localeCompare(b.scheduleId))
        .map((reminder) => ({
          schedule_id: reminder.scheduleId,
          action: "send_text",
          text: reminder.text,
          next_due_at: reminder.nextDueAt,
          recurrence: reminder.recurrence,
          recurrence_time_zone: reminder.recurrenceTimeZone,
          state: reminder.state,
        }))
    );

    const repeatedSets = await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* repeatSetsEffect() {
          const schedules = yield* Schedules;
          const oneTime = yield* schedules.set({
            action: { _tag: "SendText", text: "Buy the gift" },
            setBy: "owner",
            dueAt: DateTime.makeUnsafe(dueLater),
            sourceEventId: "source-one-time",
          });
          const repeating = yield* schedules.set({
            action: { _tag: "SendText", text: "Water the plants" },
            setBy: "owner",
            dueAt: DateTime.makeUnsafe("2100-01-01T08:00:00.000Z"),
            repeat: {
              rule: { _tag: "Daily", time: "09:00" },
              timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"),
            },
            sourceEventId: "source-repeating",
          });
          return [oneTime, repeating];
        })
      )
    );
    expect(repeatedSets).toMatchObject([
      { alreadySet: true, schedule: { scheduleId: "one-time" } },
      { alreadySet: true, schedule: { scheduleId: "repeating" } },
    ]);

    await runInDurableObject(agent, (instance, state) => {
      state.storage.sql.exec(
        "UPDATE schedules SET next_due_at = ? WHERE schedule_id = 'one-time'",
        DateTime.formatIso(
          DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
        )
      );
      return instance.fireDueSchedules();
    });

    await vi.waitFor(() =>
      expect(fakeTelegram.sent.map((sent) => sent.body.text)).toContain(
        "Buy the gift"
      )
    );
    const afterFire = await runInDurableObject(agent, (_instance, state) =>
      rowsOf(state.storage).find((row) => row.schedule_id === "one-time")
    );
    expect(afterFire?.state).toBe("done");
  });
});
