import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import type { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import {
  changeReminderToolName,
  newDueAndRepeatGivenMessage,
} from "../src/schedule/change-reminder-tool.ts";
import { listRemindersToolName } from "../src/schedule/list-reminders-tool.ts";
import { ScheduleAlarm } from "../src/schedule/schedule-alarm.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import {
  dueAndRepeatGivenMessage,
  noDueGivenMessage,
  setReminderToolName,
} from "../src/schedule/set-reminder-tool.ts";
import { nextOccurrence } from "../src/time/next-occurrence.ts";
import type { RecurrenceRule } from "../src/time/recurrence-rule.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type RepeatingServices =
  | Inbox
  | Journal
  | OwnerPreferences
  | ScheduleAlarm
  | Schedules
  | TurnTraces;

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  text: string;
  next_due_at: string;
  recurrence: string | null;
  recurrence_time_zone: string | null;
  state: string;
}

const warsaw = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");

const weeklyMondayAtNine = {
  _tag: "Weekly",
  weekdays: ["Monday"],
  time: "09:00",
} as const satisfies RecurrenceRule;

const dailyAtQuarterPastThree = {
  _tag: "Daily",
  time: "03:15",
} as const satisfies RecurrenceRule;

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, RepeatingServices>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const schedulesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ScheduleRow>(
        "SELECT schedule_id, text, next_due_at, recurrence, recurrence_time_zone, state FROM schedules ORDER BY next_due_at"
      )
      .toArray()
  );

const onlyScheduleOf = async (ownerId: string) => {
  const [row] = await schedulesOf(ownerId);
  if (row === undefined) {
    throw new Error("The Owner has no Schedule");
  }
  return row;
};

const journalTagsOf = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record._tag))
    )
  );

const alarmsOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), async (instance) => {
    const sdkSchedules = await instance.listSchedules();
    return sdkSchedules
      .filter((schedule) => schedule.callback === "fireDueSchedules")
      .map((schedule) => schedule.time);
  });

const toolCallsOf = (ownerId: string) =>
  inAgent(
    ownerId,
    TurnTraces.pipe(
      Effect.flatMap((traces) => traces.readReplies),
      Effect.map((stored) =>
        stored.flatMap(({ trace }) =>
          trace.steps.flatMap((step) => step.toolCalls)
        )
      )
    )
  );

const ownerIn = async (telegramUserId: number, timeZone: string) => {
  const ownerId = await addOwner(telegramUserId);
  await inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setTimeZone(timeZone, "setup")
      )
    )
  );
  return ownerId;
};

const owner = (telegramUserId: number, text: string) =>
  telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));

const seedRepeating = (
  ownerId: string,
  rule: RecurrenceRule,
  dueAt: DateTime.Utc
) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      yield* schedules.set({
        kind: "reminder",
        setBy: "owner",
        text: "Water the plants",
        dueAt,
        repeat: { rule, timeZone: warsaw },
        sourceEventId: "seed-repeating",
      });
      yield* (yield* ScheduleAlarm).rearm;
    })
  );

const fireTheAlarm = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );

const localTimeIn = (iso: string, zone: DateTime.TimeZone) => {
  const { hour, minute } = DateTime.toParts(
    DateTime.setZone(DateTime.makeUnsafe(iso), zone)
  );
  return [hour, minute];
};

beforeEach(() => {
  resetFakes();
});

describe("set_reminder with a repeat rule", () => {
  it("stores the rule and its time zone and tells the first local due time and the rule", async () => {
    const ownerId = await ownerIn(9101, "Europe/Warsaw");
    scriptModel([
      {
        callTool: setReminderToolName,
        input: { text: "Water the plants", repeat: weeklyMondayAtNine },
      },
      { say: "Set" },
    ]);

    await owner(9101, "remind me every Monday at 9 to water the plants");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const row = await onlyScheduleOf(ownerId);
    expect(row).toMatchObject({
      state: "active",
      recurrence_time_zone: "Europe/Warsaw",
    });
    expect(JSON.parse(row.recurrence ?? "null")).toEqual(weeklyMondayAtNine);
    expect(localTimeIn(row.next_due_at, warsaw)).toEqual([9, 0]);
    expect(
      DateTime.isGreaterThan(
        DateTime.makeUnsafe(row.next_due_at),
        DateTime.nowUnsafe()
      )
    ).toBe(true);
    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(false);
    expect(call?.output).toContain("Weekly");
    expect(call?.output).toContain("Monday");
    expect(await journalTagsOf(ownerId)).toContain("ScheduleSet");
    expect(await alarmsOf(ownerId)).toEqual([
      DateTime.toEpochMillis(DateTime.makeUnsafe(row.next_due_at)) / 1000,
    ]);
  });

  it.each([
    [
      "both a due time and a rule",
      {
        text: "x",
        localDueTime: "2099-01-01T09:00",
        repeat: weeklyMondayAtNine,
      },
      dueAndRepeatGivenMessage,
    ],
    ["neither a due time nor a rule", { text: "x" }, noDueGivenMessage],
  ])("sets no Reminder with %s", async (_name, input, message) => {
    const ownerId = await ownerIn(9102 + message.length, "Europe/Warsaw");
    scriptModel([
      { callTool: setReminderToolName, input },
      { say: "Could not" },
    ]);

    await owner(9102 + message.length, "remind me");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    expect(await schedulesOf(ownerId)).toEqual([]);
    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(true);
    expect(call?.output).toContain(message);
  });
});

describe("list_reminders and change_reminder", () => {
  it("lists the rule with the next local due time", async () => {
    const ownerId = await ownerIn(9110, "Europe/Warsaw");
    await seedRepeating(
      ownerId,
      weeklyMondayAtNine,
      nextOccurrence(weeklyMondayAtNine, DateTime.nowUnsafe(), warsaw)
    );
    scriptModel([
      { callTool: listRemindersToolName, input: {} },
      { say: "Listed" },
    ]);

    await owner(9110, "what Reminders do I have?");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const [call] = await toolCallsOf(ownerId);
    expect(call?.output).toContain("Water the plants");
    expect(call?.output).toContain('"_tag":"Weekly"');
    expect(call?.output).toContain('"timeZone":"Europe/Warsaw"');
  });

  it("changes a one-time Reminder into a repeating one and back", async () => {
    const ownerId = await ownerIn(9111, "Europe/Warsaw");
    await seedRepeating(
      ownerId,
      weeklyMondayAtNine,
      nextOccurrence(weeklyMondayAtNine, DateTime.nowUnsafe(), warsaw)
    );
    const { schedule_id: scheduleId } = await onlyScheduleOf(ownerId);
    scriptModel([
      {
        callTool: changeReminderToolName,
        input: { scheduleId, repeat: dailyAtQuarterPastThree },
      },
      { say: "Changed" },
    ]);

    await owner(9111, "make it daily at 03:15");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const changed = await onlyScheduleOf(ownerId);
    expect(JSON.parse(changed.recurrence ?? "null")).toEqual(
      dailyAtQuarterPastThree
    );
    expect(localTimeIn(changed.next_due_at, warsaw)).toEqual([3, 15]);
    expect(await journalTagsOf(ownerId)).toContain("ScheduleChanged");

    scriptModel([
      {
        callTool: changeReminderToolName,
        input: { scheduleId, localDueTime: "2099-01-04T10:00" },
      },
      { say: "Changed again" },
    ]);
    await owner(9111, "only once, on 4 January 2099 at 10");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(await onlyScheduleOf(ownerId)).toMatchObject({
      next_due_at: "2099-01-04T09:00:00.000Z",
      recurrence: null,
      recurrence_time_zone: null,
    });
  });

  it("refuses a change with both a due time and a rule", async () => {
    const ownerId = await ownerIn(9112, "Europe/Warsaw");
    await seedRepeating(
      ownerId,
      weeklyMondayAtNine,
      nextOccurrence(weeklyMondayAtNine, DateTime.nowUnsafe(), warsaw)
    );
    const before = await onlyScheduleOf(ownerId);
    scriptModel([
      {
        callTool: changeReminderToolName,
        input: {
          scheduleId: before.schedule_id,
          localDueTime: "2099-01-04T10:00",
          repeat: dailyAtQuarterPastThree,
        },
      },
      { say: "Could not" },
    ]);

    await owner(9112, "change it");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    expect(await onlyScheduleOf(ownerId)).toEqual(before);
    const [call] = await toolCallsOf(ownerId);
    expect(call?.output).toContain(newDueAndRepeatGivenMessage);
  });
});

describe("delivery of a repeating Reminder", () => {
  it("sends the text once, stays active, and moves to the next local due time", async () => {
    const ownerId = await ownerIn(9120, "Europe/Warsaw");
    await owner(9120, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const modelCallsBefore = fakeModel.doGenerateCalls.length;
    await seedRepeating(
      ownerId,
      dailyAtQuarterPastThree,
      DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
    );

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(fakeTelegram.sent[1]?.body.text).toBe("Water the plants");
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCallsBefore);
    const row = await onlyScheduleOf(ownerId);
    const next = DateTime.makeUnsafe(row.next_due_at);
    expect(row.state).toBe("active");
    expect(localTimeIn(row.next_due_at, warsaw)).toEqual([3, 15]);
    expect(DateTime.isGreaterThan(next, DateTime.nowUnsafe())).toBe(true);
    expect(
      DateTime.isLessThanOrEqualTo(
        next,
        DateTime.add(DateTime.nowUnsafe(), { hours: 25 })
      )
    ).toBe(true);
    expect(await alarmsOf(ownerId)).toEqual([
      DateTime.toEpochMillis(next) / 1000,
    ]);
    expect(await journalTagsOf(ownerId)).toEqual(
      expect.arrayContaining([
        "ScheduleFired",
        "ReplySent",
        "ScheduleRescheduled",
      ])
    );
    expect(await journalTagsOf(ownerId)).not.toContain("ScheduleCompleted");

    await fireTheAlarm(ownerId);
    expect(fakeTelegram.sent).toHaveLength(2);
  });

  it("sends one message and moves to the next future instant after several missed periods", async () => {
    const ownerId = await ownerIn(9121, "Europe/Warsaw");
    await owner(9121, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await seedRepeating(
      ownerId,
      dailyAtQuarterPastThree,
      DateTime.subtract(DateTime.nowUnsafe(), { days: 5 })
    );

    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const row = await onlyScheduleOf(ownerId);
    const next = DateTime.makeUnsafe(row.next_due_at);
    expect(DateTime.isGreaterThan(next, DateTime.nowUnsafe())).toBe(true);
    expect(
      DateTime.isLessThanOrEqualTo(
        next,
        DateTime.add(DateTime.nowUnsafe(), { hours: 25 })
      )
    ).toBe(true);
    expect(fakeTelegram.sent).toHaveLength(2);
  });
});

describe("a changed time zone", () => {
  it("moves the active repeating Schedule to the same local time in the new zone and leaves one-time Schedules", async () => {
    const ownerId = await ownerIn(9130, "Europe/Warsaw");
    await seedRepeating(
      ownerId,
      weeklyMondayAtNine,
      nextOccurrence(weeklyMondayAtNine, DateTime.nowUnsafe(), warsaw)
    );
    const oneTimeDueAt = DateTime.formatIso(
      DateTime.add(DateTime.nowUnsafe(), { days: 3 })
    );
    await inAgent(
      ownerId,
      Schedules.pipe(
        Effect.flatMap((schedules) =>
          schedules.set({
            kind: "reminder",
            setBy: "owner",
            text: "One time",
            dueAt: DateTime.makeUnsafe(oneTimeDueAt),
            sourceEventId: "seed-one-time",
          })
        )
      )
    );
    scriptModel([
      {
        callTool: setTimeZoneToolName,
        input: { timeZone: "America/New_York" },
      },
      { say: "Moved" },
    ]);

    await owner(9130, "I moved to New York");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const rows = await schedulesOf(ownerId);
    const repeating = rows.find(({ text }) => text === "Water the plants");
    const oneTime = rows.find(({ text }) => text === "One time");
    const newYork = DateTime.zoneMakeNamedUnsafe("America/New_York");
    expect(repeating).toMatchObject({
      recurrence_time_zone: "America/New_York",
      state: "active",
    });
    expect(localTimeIn(repeating?.next_due_at ?? "", newYork)).toEqual([9, 0]);
    expect(
      DateTime.toParts(
        DateTime.setZone(
          DateTime.makeUnsafe(repeating?.next_due_at ?? ""),
          newYork
        )
      ).weekDay
    ).toBe(1);
    expect(oneTime?.next_due_at).toBe(oneTimeDueAt);
    expect(await journalTagsOf(ownerId)).toContain("ScheduleChanged");
    const alarms = await alarmsOf(ownerId);
    const [first] = alarms;
    expect(first).toBe(
      Math.min(
        ...rows.map(
          ({ next_due_at: due }) =>
            DateTime.toEpochMillis(DateTime.makeUnsafe(due)) / 1000
        )
      )
    );
  });
});
