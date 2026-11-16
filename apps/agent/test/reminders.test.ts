import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import type { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { ScheduleAlarm } from "../src/schedule/schedule-alarm.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import {
  dueTimeInThePastMessage,
  invalidLocalDueTimeMessage,
  noTimeZoneForReminderMessage,
  setReminderToolName,
} from "../src/schedule/set-reminder-tool.ts";
import { localTimeOf } from "../src/time/local-time.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ReminderServices =
  | Inbox
  | Journal
  | OwnerPreferences
  | ScheduleAlarm
  | Schedules
  | TurnTraces;

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  kind: string;
  set_by: string;
  text: string;
  note_id: string | null;
  next_due_at: string;
  state: string;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, ReminderServices>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const schedulesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ScheduleRow>(
        "SELECT schedule_id, kind, set_by, text, note_id, next_due_at, state FROM schedules ORDER BY next_due_at"
      )
      .toArray()
  );

const firstScheduleState = async (ownerId: string) => {
  const rows = await schedulesOf(ownerId);
  return rows[0]?.state;
};

const toolNamesOf = (call: {
  readonly tools?: readonly { readonly name: string }[] | undefined;
}) => (call.tools ?? []).map((tool) => tool.name);

const sentTexts = () => fakeTelegram.sent.map((sent) => sent.body.text);

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

const ownerInWarsaw = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  await inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setTimeZone("Europe/Warsaw", "setup")
      )
    )
  );
  return ownerId;
};

const nextYear = DateTime.getPartUtc(DateTime.nowUnsafe(), "year") + 1;

const setReminderStep = (localDueTime: string, noteId?: string) =>
  ({
    callTool: setReminderToolName,
    input: {
      text: "Buy the gift for Ana",
      localDueTime,
      ...(noteId === undefined ? {} : { noteId }),
    },
  }) as const;

const owner = (telegramUserId: number, text: string) =>
  telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));

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

const dueAgo = (text: string, ago: Partial<DateTime.DateTime.PartsForMath>) =>
  Schedules.pipe(
    Effect.flatMap((schedules) =>
      Effect.gen(function* setDueScheduleEffect() {
        const now = yield* DateTime.now;
        return yield* schedules.set({
          kind: "reminder",
          setBy: "owner",
          text,
          dueAt: DateTime.subtract(now, ago),
          sourceEventId: `setup-${text}`,
        });
      })
    ),
    Effect.map(({ schedule }) => schedule)
  );

const dueInThePast = (text: string) => dueAgo(text, { seconds: 5 });

const fireTheAlarm = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );

beforeEach(() => {
  resetFakes();
});

describe("set_reminder", () => {
  it("stores one active Schedule at the UTC instant of the Warsaw time and tells the local time", async () => {
    const ownerId = await ownerInWarsaw(9001);
    scriptModel([
      setReminderStep(`${nextYear}-01-14T09:00`),
      { say: "Reminder set" },
    ]);

    await owner(9001, "remind me Thursday at 9 to buy the gift");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    expect(await schedulesOf(ownerId)).toEqual([
      expect.objectContaining({
        kind: "reminder",
        set_by: "owner",
        text: "Buy the gift for Ana",
        note_id: null,
        next_due_at: `${nextYear}-01-14T08:00:00.000Z`,
        state: "active",
      }),
    ]);
    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(false);
    expect(call?.output).toContain(`${nextYear}-01-14, 09:00`);
    expect(call?.output).toContain("Europe/Warsaw");
    expect(await journalTagsOf(ownerId)).toContain("ScheduleSet");
  });

  it("links the Reminder to the Note that the same message kept", async () => {
    const ownerId = await ownerInWarsaw(9002);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "buy the gift for Ana" },
      },
      {
        callTool: setReminderToolName,
        input: ({ noteId }) => ({
          text: "Buy the gift for Ana",
          localDueTime: `${nextYear}-01-14T09:00`,
          noteId,
        }),
      },
      { say: "Kept and set" },
    ]);

    await owner(9002, "buy the gift for Ana, remind me Thursday at 9");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const notes = await runInDurableObject(await agentOf(ownerId), (_, state) =>
      state.storage.sql
        .exec<{ note_id: string }>("SELECT note_id FROM notes")
        .toArray()
    );
    const schedules = await schedulesOf(ownerId);
    expect(notes).toHaveLength(1);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.note_id).toBe(notes[0]?.note_id);
  });

  it("creates one Schedule when a failed model call is followed by the same call again", async () => {
    const ownerId = await ownerInWarsaw(9003);
    scriptModel([
      setReminderStep(`${nextYear}-01-14T09:00`),
      { error: "The model provider is down" },
      setReminderStep(`${nextYear}-01-14T09:00`),
      { say: "Reminder set" },
    ]);

    await owner(9003, "remind me Thursday at 9 to buy the gift");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 15_000,
    });
    expect(await schedulesOf(ownerId)).toHaveLength(1);
    const journalTags = await journalTagsOf(ownerId);
    expect(journalTags.filter((tag) => tag === "ScheduleSet")).toHaveLength(1);
  });

  it("sets no Reminder without a time zone and tells the model to ask", async () => {
    const ownerId = await addOwner(9004);
    scriptModel([
      setReminderStep(`${nextYear}-01-14T09:00`),
      { say: "Where do you live?" },
    ]);

    await owner(9004, "remind me Thursday at 9");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    expect(await schedulesOf(ownerId)).toEqual([]);
    expect(await alarmsOf(ownerId)).toEqual([]);
    const [call] = await toolCallsOf(ownerId);
    expect(call).toMatchObject({
      failed: true,
      output: expect.stringContaining(noTimeZoneForReminderMessage),
    });
  });

  it("refuses a due time in the past and a time that does not exist", async () => {
    const ownerId = await ownerInWarsaw(9005);
    scriptModel([
      setReminderStep("2020-01-14T09:00"),
      setReminderStep(`${nextYear}-02-30T09:00`),
      { say: "Sorry" },
    ]);

    await owner(9005, "remind me at some time");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    expect(await schedulesOf(ownerId)).toEqual([]);
    const calls = await toolCallsOf(ownerId);
    expect(calls.map((call) => call.output)).toEqual([
      expect.stringContaining(dueTimeInThePastMessage),
      expect.stringContaining(invalidLocalDueTimeMessage),
    ]);
  });

  it("gives the tool to an Owner message and not to a forwarded message", async () => {
    await ownerInWarsaw(9006);
    scriptModel([{ say: "ok" }]);

    await owner(9006, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    expect(toolNamesOf(fakeModel.doGenerateCalls[0] ?? {})).toContain(
      setReminderToolName
    );

    scriptModel([{ say: "ok" }]);
    await telegramWebhook(
      textUpdate({
        fromUserId: 9006,
        text: "forwarded",
        forwardOrigin: {
          type: "user",
          date: 1_794_000_000,
          sender_user: { id: 5, is_bot: false, first_name: "Ana" },
        },
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(toolNamesOf(fakeModel.doGenerateCalls[1] ?? {})).not.toContain(
      setReminderToolName
    );
  });
});

describe("the alarm", () => {
  it("arms the SDK alarm at the due instant after a set and leaves none when no Schedule is active", async () => {
    const ownerId = await ownerInWarsaw(9010);
    expect(await alarmsOf(ownerId)).toEqual([]);
    scriptModel([
      setReminderStep(`${nextYear}-01-14T09:00`),
      { say: "Reminder set" },
    ]);

    await owner(9010, "remind me");

    await vi.waitFor(async () =>
      expect(await alarmsOf(ownerId)).toEqual([
        DateTime.toEpochMillis(
          DateTime.makeUnsafe(`${nextYear}-01-14T08:00:00.000Z`)
        ) / 1000,
      ])
    );
  });

  it("keeps one alarm at the earliest due instant and moves it after a fire", async () => {
    const ownerId = await ownerInWarsaw(9011);
    const later = DateTime.makeUnsafe(`${nextYear}-03-01T08:00:00.000Z`);
    const earlier = DateTime.makeUnsafe(`${nextYear}-02-01T08:00:00.000Z`);
    await inAgent(
      ownerId,
      Effect.gen(function* armEffect() {
        const schedules = yield* Schedules;
        const alarm = yield* ScheduleAlarm;
        for (const [text, dueAt] of [
          ["later", later],
          ["earlier", earlier],
        ] as const) {
          yield* schedules.set({
            kind: "reminder",
            setBy: "owner",
            text,
            dueAt,
            sourceEventId: text,
          });
          yield* alarm.rearm;
        }
      })
    );
    expect(await alarmsOf(ownerId)).toEqual([
      DateTime.toEpochMillis(earlier) / 1000,
    ]);

    await inAgent(ownerId, dueInThePast("now"));
    await fireTheAlarm(ownerId);

    expect(await alarmsOf(ownerId)).toEqual([
      DateTime.toEpochMillis(earlier) / 1000,
    ]);
    await inAgent(
      ownerId,
      Effect.gen(function* completeEarlierEffect() {
        const schedules = yield* Schedules;
        const rows = yield* Effect.promise(() => schedulesOf(ownerId));
        const active = rows.find((row) => row.text === "earlier");
        yield* schedules.complete(
          active?.schedule_id ?? "",
          active?.next_due_at ?? "",
          "setup"
        );
        yield* (yield* ScheduleAlarm).rearm;
      })
    );
    expect(await alarmsOf(ownerId)).toEqual([
      DateTime.toEpochMillis(later) / 1000,
    ]);
  });
});

describe("Reminder delivery", () => {
  it("sends the saved text once at the due time with no model call", async () => {
    const ownerId = await ownerInWarsaw(9020);
    await owner(9020, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const modelCallsBefore = fakeModel.doGenerateCalls.length;
    await inAgent(ownerId, dueInThePast("Buy the gift for Ana"));

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe("Buy the gift for Ana");
    expect(fakeTelegram.sent[1]?.body.reply_parameters).toBeUndefined();
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCallsBefore);
    expect(await firstScheduleState(ownerId)).toBe("done");
    expect(await journalTagsOf(ownerId)).toEqual(
      expect.arrayContaining([
        "ScheduleSet",
        "ScheduleFired",
        "ReplySent",
        "ScheduleCompleted",
      ])
    );
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({
      task: "reminder_delivery",
      result: "reminder_delivered",
      text: "Buy the gift for Ana",
    });
    expect(await alarmsOf(ownerId)).toEqual([]);
    expect(
      fakeMetrics.dataPoints.some((point) => point.blobs?.[0] === "reminder")
    ).toBe(true);
  });

  it("sends one message when the alarm runs twice for the same due time", async () => {
    const ownerId = await ownerInWarsaw(9021);
    await owner(9021, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await inAgent(ownerId, dueInThePast("once"));

    await Promise.all([fireTheAlarm(ownerId), fireTheAlarm(ownerId)]);
    await fireTheAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await firstScheduleState(ownerId)).toBe("done")
    );
    expect(sentTexts().filter((text) => text === "once")).toHaveLength(1);
  });

  it("sends one message when the Durable Object resets after the Inbox write and before the send", async () => {
    const ownerId = await ownerInWarsaw(9022);
    await owner(9022, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await inAgent(ownerId, dueInThePast("after reset"));
    await inAgent(ownerId, storeDueScheduleEvents);
    expect(sentTexts()).not.toContain("after reset");

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await firstScheduleState(ownerId)).toBe("done")
    );
    expect(sentTexts().filter((text) => text === "after reset")).toHaveLength(
      1
    );
  });

  it("does not send again when the Durable Object resets after the send and before the Schedule is done", async () => {
    const ownerId = await ownerInWarsaw(9023);
    await owner(9023, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const schedule = await inAgent(ownerId, dueInThePast("sent already"));
    await inAgent(ownerId, storeDueScheduleEvents);
    await inAgent(
      ownerId,
      Effect.gen(function* sentEffect() {
        const journal = yield* Journal;
        const entries = yield* journal.read;
        const fired = entries.find(
          (entry) =>
            entry.record._tag === "ScheduleFired" &&
            entry.record.scheduleId === schedule.scheduleId
        );
        const eventId = fired?.record.eventId ?? "";
        yield* journal.append({ _tag: "ReplyPlanned", eventId, text: "x" });
        yield* journal.append({ _tag: "SendStarted", eventId });
        yield* journal.append({
          _tag: "ReplySent",
          eventId,
          channelMessageId: "1",
        });
      })
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await firstScheduleState(ownerId)).toBe("done")
    );
    expect(sentTexts()).toEqual(["You said: hello"]);
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({
      result: "reminder_delivered",
      channelMessageId: "1",
    });
  });

  it("never sends again when the Durable Object resets after SendStarted and before Telegram confirms", async () => {
    const ownerId = await ownerInWarsaw(9025);
    await owner(9025, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const schedule = await inAgent(ownerId, dueInThePast("maybe sent"));
    await inAgent(ownerId, storeDueScheduleEvents);
    await inAgent(
      ownerId,
      Effect.gen(function* startedEffect() {
        const journal = yield* Journal;
        const entries = yield* journal.read;
        const fired = entries.find(
          (entry) =>
            entry.record._tag === "ScheduleFired" &&
            entry.record.scheduleId === schedule.scheduleId
        );
        const eventId = fired?.record.eventId ?? "";
        yield* journal.append({ _tag: "ReplyPlanned", eventId, text: "x" });
        yield* journal.append({ _tag: "SendStarted", eventId });
      })
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await journalTagsOf(ownerId)).toContain("ReplyFailed")
    );
    expect(sentTexts()).toEqual(["You said: hello"]);
    expect(await firstScheduleState(ownerId)).toBe("active");
    expect(await alarmsOf(ownerId)).toEqual([]);
  });

  it("writes the missing failure Trace when the Durable Object resets after a refused send", async () => {
    const ownerId = await ownerInWarsaw(9026);
    await owner(9026, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const schedule = await inAgent(ownerId, dueInThePast("refused"));
    await inAgent(ownerId, storeDueScheduleEvents);
    await inAgent(
      ownerId,
      Effect.gen(function* refusedEffect() {
        const journal = yield* Journal;
        const entries = yield* journal.read;
        const fired = entries.find(
          (entry) =>
            entry.record._tag === "ScheduleFired" &&
            entry.record.scheduleId === schedule.scheduleId
        );
        const eventId = fired?.record.eventId ?? "";
        yield* journal.append({ _tag: "ReplyPlanned", eventId, text: "x" });
        yield* journal.append({ _tag: "SendStarted", eventId });
        yield* journal.append({
          _tag: "ReplyFailed",
          eventId,
          reason: "Bad Request: chat not found",
        });
      })
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(async () => {
      const traces = await inAgent(
        ownerId,
        TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
      );
      expect(
        traces.filter(
          ({ trace }) => trace.result === "reminder_delivery_failed"
        )
      ).toHaveLength(1);
    });
    expect(sentTexts()).toEqual(["You said: hello"]);
  });

  it("records a failed send honestly, keeps the Schedule active, and does not arm a hot alarm", async () => {
    const ownerId = await ownerInWarsaw(9024);
    await owner(9024, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    fakeTelegram.answerWith("refuse");
    await inAgent(ownerId, dueInThePast("will fail"));

    await fireTheAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await journalTagsOf(ownerId)).toContain("ReplyFailed")
    );
    expect(await firstScheduleState(ownerId)).toBe("active");
    expect(await alarmsOf(ownerId)).toEqual([]);
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({
      result: "reminder_delivery_failed",
    });
  });
});

describe("Late Reminders", () => {
  it("sends the saved text with no late note inside the grace period", async () => {
    const ownerId = await ownerInWarsaw(9030);
    await owner(9030, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await inAgent(ownerId, dueAgo("Buy the gift", { minutes: 4 }));

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe("Buy the gift");
    expect(await journalTagsOf(ownerId)).not.toContain("ReminderLate");
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({ late: false });
  });

  it("says that it is late and gives the local due time after the grace period, and sends it once", async () => {
    const ownerId = await ownerInWarsaw(9031);
    await owner(9031, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const modelCallsBefore = fakeModel.doGenerateCalls.length;
    const schedule = await inAgent(
      ownerId,
      dueAgo("Buy the gift", { hours: 2 })
    );
    const expectedLocalTime = await inAgent(
      ownerId,
      Effect.sync(() =>
        localTimeOf(
          schedule.nextDueAt,
          DateTime.zoneMakeNamedUnsafe("Europe/Warsaw")
        )
      )
    );

    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(
      `This Reminder is late. It was due ${expectedLocalTime} (Europe/Warsaw): Buy the gift`
    );
    expect(fakeTelegram.sent).toHaveLength(2);
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCallsBefore);
    expect(await firstScheduleState(ownerId)).toBe("done");
  });

  it("records in the Journal Entry and the Trace that the Reminder was late", async () => {
    const ownerId = await ownerInWarsaw(9032);
    await owner(9032, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const schedule = await inAgent(
      ownerId,
      dueAgo("Buy the gift", { hours: 2 })
    );

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const entries = await inAgent(
      ownerId,
      Journal.pipe(Effect.flatMap((journal) => journal.read))
    );
    const late = entries
      .map((entry) => entry.record)
      .filter((record) => record._tag === "ReminderLate");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      scheduleId: schedule.scheduleId,
      dueAt: DateTime.formatIso(schedule.nextDueAt),
    });
    expect(late[0]?.lateByMillis).toBeGreaterThanOrEqual(2 * 3_600_000);
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({
      result: "reminder_delivered",
      late: true,
    });
  });
});

const lateFireWithJournal = async (
  ownerId: string,
  records: readonly ("ReplyPlanned" | "SendStarted" | "ReplySent")[]
) => {
  const schedule = await inAgent(ownerId, dueAgo("Buy the gift", { hours: 2 }));
  await inAgent(ownerId, storeDueScheduleEvents);
  await inAgent(
    ownerId,
    Effect.gen(function* seedLateFireEffect() {
      const journal = yield* Journal;
      const entries = yield* journal.read;
      const eventId =
        entries.find(
          (entry) =>
            entry.record._tag === "ScheduleFired" &&
            entry.record.scheduleId === schedule.scheduleId
        )?.record.eventId ?? "";
      yield* journal.append({
        _tag: "ReminderLate",
        eventId,
        scheduleId: schedule.scheduleId,
        dueAt: DateTime.formatIso(schedule.nextDueAt),
        lateByMillis: 2 * 3_600_000,
      });
      if (records.includes("ReplyPlanned")) {
        yield* journal.append({
          _tag: "ReplyPlanned",
          eventId,
          text: "late text",
        });
      }
      if (records.includes("SendStarted")) {
        yield* journal.append({ _tag: "SendStarted", eventId });
      }
      if (records.includes("ReplySent")) {
        yield* journal.append({
          _tag: "ReplySent",
          eventId,
          channelMessageId: "1",
        });
      }
    })
  );
};

const lateEntriesOf = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) =>
        entries.filter((entry) => entry.record._tag === "ReminderLate")
      )
    )
  );

describe("Late Reminders after a reset", () => {
  it("writes the Trace with late: true and sends nothing again when the Durable Object resets after the send", async () => {
    const ownerId = await ownerInWarsaw(9033);
    await owner(9033, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await lateFireWithJournal(ownerId, [
      "ReplyPlanned",
      "SendStarted",
      "ReplySent",
    ]);

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await firstScheduleState(ownerId)).toBe("done")
    );
    expect(sentTexts()).toEqual(["You said: hello"]);
    expect(await lateEntriesOf(ownerId)).toHaveLength(1);
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({
      result: "reminder_delivered",
      late: true,
      text: "late text",
    });
  });

  it("sends the late text once and writes one ReminderLate entry when the Durable Object resets before the send", async () => {
    const ownerId = await ownerInWarsaw(9034);
    await owner(9034, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await lateFireWithJournal(ownerId, []);

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toContain("This Reminder is late.");
    expect(await lateEntriesOf(ownerId)).toHaveLength(1);
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({ late: true });
  });
});
