import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import type { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { cancelScheduleToolName } from "../src/schedule/cancel-schedule-tool.ts";
import {
  changeScheduleToolName,
  invalidNewDueTimeMessage,
  newDueTimeInThePastMessage,
  nothingToChangeMessage,
} from "../src/schedule/change-schedule-tool.ts";
import { listSchedulesToolName } from "../src/schedule/list-schedules-tool.ts";
import { noActiveScheduleMessage } from "../src/schedule/schedule-presentation.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ControlServices =
  | Inbox
  | Journal
  | OwnerPreferences
  | Schedules
  | TurnTraces;

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  action: string;
  text: string;
  next_due_at: string;
  state: string;
}

const nextYear = DateTime.getPartUtc(DateTime.nowUnsafe(), "year") + 1;

const utc = (monthDayTime: string) =>
  DateTime.makeUnsafe(`${nextYear}-${monthDayTime}Z`);

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, ControlServices>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const schedulesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ScheduleRow>(
        "SELECT schedule_id, action, text, next_due_at, state FROM schedules ORDER BY next_due_at"
      )
      .toArray()
  );

const rowOf = async (ownerId: string, text: string) => {
  const rows = await schedulesOf(ownerId);
  const row = rows.find((found) => found.text === text);
  if (row === undefined) {
    throw new Error(`No Schedule has the text ${text}`);
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

const alarmAt = (instant: DateTime.Utc) => [
  DateTime.toEpochMillis(instant) / 1000,
];

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

const seedReminder = (ownerId: string, text: string, dueAt: DateTime.Utc) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      yield* schedules.set({
        action: { _tag: "SendText", text },
        setBy: "owner",
        dueAt,
        sourceEventId: `seed-${text}`,
      });
    })
  );

const seedScheduledTask = (
  ownerId: string,
  prompt: string,
  dueAt: DateTime.Utc
) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      yield* schedules.set({
        action: { _tag: "RunPrompt", prompt },
        setBy: "owner",
        dueAt,
        sourceEventId: `seed-${prompt}`,
      });
    })
  );

const scheduleJournalOf = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) =>
        entries.flatMap(({ record }) =>
          record._tag === "ScheduleChanged" ||
          record._tag === "ScheduleCancelled"
            ? [{ tag: record._tag, scheduleId: record.scheduleId }]
            : []
        )
      )
    )
  );

const dueSecondsAgo = (seconds: number) =>
  DateTime.subtract(DateTime.nowUnsafe(), { seconds });

const changeAt = async (ownerId: string, text: string, dueAt: DateTime.Utc) => {
  const { schedule_id: scheduleId } = await rowOf(ownerId, text);
  await inAgent(
    ownerId,
    Effect.gen(function* changeEffect() {
      const schedules = yield* Schedules;
      yield* schedules.change({
        scheduleId,
        dueAt,
        eventId: "setup",
      });
    })
  );
};

const owner = (telegramUserId: number, text: string) =>
  telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));

const fireTheAlarm = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );

const sentTexts = () => fakeTelegram.sent.map((sent) => sent.body.text);

const toolNamesOf = (call: {
  readonly tools?: readonly { readonly name: string }[] | undefined;
}) => (call.tools ?? []).map((tool) => tool.name);

const askAndWaitForReply = async (telegramUserId: number, text: string) => {
  const repliesBefore = fakeTelegram.sent.length;
  await owner(telegramUserId, text);
  await vi.waitUntil(() => fakeTelegram.sent.length > repliesBefore, {
    timeout: 5000,
  });
};

beforeEach(() => {
  resetFakes();
});

describe("list_schedules", () => {
  it("lists the active Reminders in local time, earliest first, and no done or cancelled Reminder", async () => {
    const ownerId = await ownerInWarsaw(9101);
    await seedReminder(ownerId, "second", utc("02-01T08:00:00.000"));
    await seedReminder(ownerId, "first", utc("01-14T08:00:00.000"));
    await seedReminder(ownerId, "finished", utc("01-10T08:00:00.000"));
    await seedReminder(ownerId, "dropped", utc("01-11T08:00:00.000"));
    const finished = await rowOf(ownerId, "finished");
    const dropped = await rowOf(ownerId, "dropped");
    await inAgent(
      ownerId,
      Effect.gen(function* retireEffect() {
        const schedules = yield* Schedules;
        yield* schedules.complete(
          finished.schedule_id,
          finished.next_due_at,
          "setup"
        );
        yield* schedules.cancel({
          scheduleId: dropped.schedule_id,
          eventId: "setup",
        });
      })
    );
    scriptModel([
      { callTool: listSchedulesToolName, input: {} },
      { say: "Here" },
    ]);

    await askAndWaitForReply(9101, "what Reminders do I have?");

    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(false);
    const output = call?.output ?? "";
    expect(output).toContain(`${nextYear}-01-14, 09:00`);
    expect(output).toContain(`${nextYear}-02-01, 09:00`);
    expect(output).toContain("Europe/Warsaw");
    expect(output).toContain('"action":{"_tag":"SendText","text":"first"}');
    expect(output).not.toContain("finished");
    expect(output).not.toContain("dropped");
    expect(output.indexOf("first")).toBeLessThan(output.indexOf("second"));
  });

  it("returns an empty list when no Reminder is active", async () => {
    const ownerId = await ownerInWarsaw(9102);
    scriptModel([
      { callTool: listSchedulesToolName, input: {} },
      { say: "None" },
    ]);

    await askAndWaitForReply(9102, "what Reminders do I have?");

    const [call] = await toolCallsOf(ownerId);
    expect(call?.output).toContain('"schedules":[]');
  });
});

describe("change_schedule", () => {
  it("moves the Reminder, arms the alarm at the earliest due instant, and writes a Journal Entry", async () => {
    const ownerId = await ownerInWarsaw(9110);
    await seedReminder(ownerId, "gift", utc("01-14T08:00:00.000"));
    await seedReminder(ownerId, "tax", utc("02-01T08:00:00.000"));
    expect(await alarmsOf(ownerId)).toEqual(alarmAt(utc("01-14T08:00:00.000")));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "gift");
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: { scheduleId, localDueTime: `${nextYear}-03-01T10:00` },
      },
      { say: "Moved" },
    ]);

    await askAndWaitForReply(9110, "move the gift to March 1 at 10");

    expect(await rowOf(ownerId, "gift")).toMatchObject({
      next_due_at: `${nextYear}-03-01T09:00:00.000Z`,
      state: "active",
    });
    expect(await alarmsOf(ownerId)).toEqual(alarmAt(utc("02-01T08:00:00.000")));
    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(false);
    expect(call?.output).toContain(`${nextYear}-03-01, 10:00`);
    expect(await journalTagsOf(ownerId)).toContain("ScheduleChanged");
  });

  it("changes only the text and keeps the due time", async () => {
    const ownerId = await ownerInWarsaw(9111);
    await seedReminder(ownerId, "gift", utc("01-14T08:00:00.000"));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "gift");
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: {
          scheduleId,
          action: { _tag: "SendText", text: "Buy the gift and a card" },
        },
      },
      { say: "Reworded" },
    ]);

    await askAndWaitForReply(9111, "also buy a card");

    expect(await schedulesOf(ownerId)).toEqual([
      expect.objectContaining({
        text: "Buy the gift and a card",
        next_due_at: `${nextYear}-01-14T08:00:00.000Z`,
      }),
    ]);
    expect(await alarmsOf(ownerId)).toEqual(alarmAt(utc("01-14T08:00:00.000")));
  });

  it("changes nothing and tells the model when the id is unknown, done, or cancelled", async () => {
    const ownerId = await ownerInWarsaw(9112);
    await seedReminder(ownerId, "finished", utc("01-10T08:00:00.000"));
    await seedReminder(ownerId, "dropped", utc("01-11T08:00:00.000"));
    const finished = await rowOf(ownerId, "finished");
    const dropped = await rowOf(ownerId, "dropped");
    await inAgent(
      ownerId,
      Effect.gen(function* retireEffect() {
        const schedules = yield* Schedules;
        yield* schedules.complete(
          finished.schedule_id,
          finished.next_due_at,
          "setup"
        );
        yield* schedules.cancel({
          scheduleId: dropped.schedule_id,
          eventId: "setup",
        });
      })
    );
    const before = await schedulesOf(ownerId);
    const input = { localDueTime: `${nextYear}-05-01T10:00` };
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: { ...input, scheduleId: "nope" },
      },
      {
        callTool: changeScheduleToolName,
        input: { ...input, scheduleId: finished.schedule_id },
      },
      {
        callTool: changeScheduleToolName,
        input: { ...input, scheduleId: dropped.schedule_id },
      },
      { say: "Nothing changed" },
    ]);

    await askAndWaitForReply(9112, "move it");

    const calls = await toolCallsOf(ownerId);
    expect(calls.map((call) => [call.failed, call.output])).toEqual([
      [true, expect.stringContaining(noActiveScheduleMessage("nope"))],
      [
        true,
        expect.stringContaining(noActiveScheduleMessage(finished.schedule_id)),
      ],
      [
        true,
        expect.stringContaining(noActiveScheduleMessage(dropped.schedule_id)),
      ],
    ]);
    expect(await schedulesOf(ownerId)).toEqual(before);
    expect(await journalTagsOf(ownerId)).not.toContain("ScheduleChanged");
  });

  it("refuses a new time in the past, a time that does not exist, and an empty change", async () => {
    const ownerId = await ownerInWarsaw(9113);
    await seedReminder(ownerId, "gift", utc("01-14T08:00:00.000"));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "gift");
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: { scheduleId, localDueTime: "2020-01-14T09:00" },
      },
      {
        callTool: changeScheduleToolName,
        input: { scheduleId, localDueTime: `${nextYear}-02-30T09:00` },
      },
      { callTool: changeScheduleToolName, input: { scheduleId } },
      { say: "Sorry" },
    ]);

    await askAndWaitForReply(9113, "move it");

    const calls = await toolCallsOf(ownerId);
    expect(calls.map((call) => call.output)).toEqual([
      expect.stringContaining(newDueTimeInThePastMessage),
      expect.stringContaining(invalidNewDueTimeMessage),
      expect.stringContaining(nothingToChangeMessage),
    ]);
    expect(await rowOf(ownerId, "gift")).toMatchObject({
      next_due_at: `${nextYear}-01-14T08:00:00.000Z`,
    });
    expect(await alarmsOf(ownerId)).toEqual(alarmAt(utc("01-14T08:00:00.000")));
  });

  it("fires at the new due instant and not at the old one", async () => {
    const ownerId = await ownerInWarsaw(9114);
    await owner(9114, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await seedReminder(ownerId, "moved", dueSecondsAgo(5));

    await changeAt(ownerId, "moved", utc("06-01T08:00:00.000"));
    await fireTheAlarm(ownerId);

    expect(sentTexts()).not.toContain("moved");
    expect(await alarmsOf(ownerId)).toEqual(alarmAt(utc("06-01T08:00:00.000")));

    await changeAt(ownerId, "moved", dueSecondsAgo(1));
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(sentTexts()).toContain("moved"));
    expect(sentTexts().filter((text) => text === "moved")).toHaveLength(1);
  });
});

describe("cancel_schedule", () => {
  it("cancels the Reminder, leaves no alarm, and writes a Journal Entry", async () => {
    const ownerId = await ownerInWarsaw(9120);
    await seedReminder(ownerId, "gift", utc("01-14T08:00:00.000"));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "gift");
    scriptModel([
      { callTool: cancelScheduleToolName, input: { scheduleId } },
      { say: "Cancelled" },
    ]);

    await askAndWaitForReply(9120, "cancel it");

    expect(await rowOf(ownerId, "gift")).toMatchObject({ state: "cancelled" });
    expect(await alarmsOf(ownerId)).toEqual([]);
    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(false);
    expect(await journalTagsOf(ownerId)).toContain("ScheduleCancelled");
  });

  it("moves the alarm to the next Reminder after a cancel", async () => {
    const ownerId = await ownerInWarsaw(9121);
    await seedReminder(ownerId, "gift", utc("01-14T08:00:00.000"));
    await seedReminder(ownerId, "tax", utc("02-01T08:00:00.000"));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "gift");
    scriptModel([
      { callTool: cancelScheduleToolName, input: { scheduleId } },
      { say: "Cancelled" },
    ]);

    await askAndWaitForReply(9121, "cancel the gift");

    expect(await alarmsOf(ownerId)).toEqual(alarmAt(utc("02-01T08:00:00.000")));
  });

  it("changes nothing and tells the model when the id is unknown or the Reminder is already cancelled", async () => {
    const ownerId = await ownerInWarsaw(9122);
    await seedReminder(ownerId, "gift", utc("01-14T08:00:00.000"));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "gift");
    scriptModel([
      { callTool: cancelScheduleToolName, input: { scheduleId } },
      { callTool: cancelScheduleToolName, input: { scheduleId } },
      { callTool: cancelScheduleToolName, input: { scheduleId: "nope" } },
      { say: "Done" },
    ]);

    await askAndWaitForReply(9122, "cancel it twice");

    const calls = await toolCallsOf(ownerId);
    expect(calls.map((call) => call.failed)).toEqual([false, true, true]);
    expect(calls[2]?.output).toContain(noActiveScheduleMessage("nope"));
    const tags = await journalTagsOf(ownerId);
    expect(tags.filter((tag) => tag === "ScheduleCancelled")).toHaveLength(1);
  });

  it("never fires a cancelled Reminder", async () => {
    const ownerId = await ownerInWarsaw(9123);
    await owner(9123, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await seedReminder(ownerId, "never", dueSecondsAgo(5));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "never");
    await inAgent(
      ownerId,
      Effect.gen(function* cancelEffect() {
        const schedules = yield* Schedules;
        yield* schedules.cancel({
          scheduleId,
          eventId: "setup",
        });
      })
    );

    await fireTheAlarm(ownerId);

    expect(sentTexts()).not.toContain("never");
    expect(await journalTagsOf(ownerId)).not.toContain("ScheduleFired");
  });

  it("sends no Reminder that is cancelled after its Event entered the Inbox", async () => {
    const ownerId = await ownerInWarsaw(9124);
    await owner(9124, "hello");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await seedReminder(ownerId, "too late", dueSecondsAgo(5));
    await inAgent(ownerId, storeDueScheduleEvents);
    const { schedule_id: scheduleId } = await rowOf(ownerId, "too late");
    scriptModel([
      { callTool: cancelScheduleToolName, input: { scheduleId } },
      { say: "Cancelled" },
    ]);

    await askAndWaitForReply(9124, "cancel it");

    await fireTheAlarm(ownerId);
    expect(sentTexts()).not.toContain("too late");
    expect(await rowOf(ownerId, "too late")).toMatchObject({
      state: "cancelled",
    });
  });
});

describe("the Reminder controls", () => {
  it("are given to an Owner message and not to a forwarded message", async () => {
    await ownerInWarsaw(9130);
    scriptModel([{ say: "ok" }]);
    await askAndWaitForReply(9130, "hello");
    const ownerTools = toolNamesOf(fakeModel.doGenerateCalls[0] ?? {});
    expect(ownerTools).toEqual(
      expect.arrayContaining([
        listSchedulesToolName,
        changeScheduleToolName,
        cancelScheduleToolName,
      ])
    );

    scriptModel([{ say: "ok" }]);
    await telegramWebhook(
      textUpdate({
        fromUserId: 9130,
        text: "forwarded",
        forwardOrigin: {
          type: "user",
          date: 1_794_000_000,
          sender_user: { id: 5, is_bot: false, first_name: "Ana" },
        },
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const forwardedTools = toolNamesOf(fakeModel.doGenerateCalls[1] ?? {});
    for (const name of [
      listSchedulesToolName,
      changeScheduleToolName,
      cancelScheduleToolName,
    ]) {
      expect(forwardedTools).not.toContain(name);
    }
  });
});

describe("Scheduled Tasks in the Schedule controls", () => {
  it("lists a Reminder and a Scheduled Task, each with its Action", async () => {
    const ownerId = await ownerInWarsaw(9140);
    await seedReminder(ownerId, "gift", utc("01-14T08:00:00.000"));
    await seedScheduledTask(
      ownerId,
      "list my tasks",
      utc("02-01T08:00:00.000")
    );
    scriptModel([
      { callTool: listSchedulesToolName, input: {} },
      { say: "Here" },
    ]);

    await askAndWaitForReply(9140, "what is scheduled?");

    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(false);
    expect(call?.output).toContain(
      '"action":{"_tag":"SendText","text":"gift"}'
    );
    expect(call?.output).toContain(
      '"action":{"_tag":"RunPrompt","prompt":"list my tasks"}'
    );
  });

  it("changes the prompt of a Scheduled Task, and the next fire uses the new prompt", async () => {
    const ownerId = await ownerInWarsaw(9141);
    await seedScheduledTask(
      ownerId,
      "list my tasks",
      utc("06-01T08:00:00.000")
    );
    const { schedule_id: scheduleId } = await rowOf(ownerId, "list my tasks");
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: {
          scheduleId,
          action: { _tag: "RunPrompt", prompt: "list my notes" },
        },
      },
      { say: "Changed" },
    ]);
    await askAndWaitForReply(9141, "list notes instead");
    const sentBefore = fakeTelegram.sent.length;
    await changeAt(ownerId, "list my notes", dueSecondsAgo(5));

    await fireTheAlarm(ownerId);

    await vi.waitFor(() =>
      expect(sentTexts().slice(sentBefore)).toContain("You said: list my notes")
    );
    expect(await journalTagsOf(ownerId)).toContain("ScheduleChanged");
    expect(await scheduleJournalOf(ownerId)).toContainEqual({
      tag: "ScheduleChanged",
      scheduleId,
    });
  });

  it("changes a SendText Schedule into a Scheduled Task, and the next fire runs the prompt", async () => {
    const ownerId = await ownerInWarsaw(9142);
    await seedReminder(ownerId, "gift", utc("06-01T08:00:00.000"));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "gift");
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: {
          scheduleId,
          action: { _tag: "RunPrompt", prompt: "list my tasks" },
        },
      },
      { say: "Changed" },
    ]);
    await askAndWaitForReply(9142, "make it a task");
    const sentBefore = fakeTelegram.sent.length;
    await changeAt(ownerId, "list my tasks", dueSecondsAgo(5));

    await fireTheAlarm(ownerId);

    await vi.waitFor(() =>
      expect(sentTexts().slice(sentBefore)).toContain("You said: list my tasks")
    );
    expect(await rowOf(ownerId, "list my tasks")).toMatchObject({
      action: "run_prompt",
    });
  });

  it("changes a Scheduled Task into a SendText Schedule, and the next fire sends the text with no model call", async () => {
    const ownerId = await ownerInWarsaw(9143);
    await seedScheduledTask(
      ownerId,
      "list my tasks",
      utc("06-01T08:00:00.000")
    );
    const { schedule_id: scheduleId } = await rowOf(ownerId, "list my tasks");
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: {
          scheduleId,
          action: { _tag: "SendText", text: "Check your tasks" },
        },
      },
      { say: "Changed" },
    ]);
    await askAndWaitForReply(9143, "just remind me");
    const sentBefore = fakeTelegram.sent.length;
    await changeAt(ownerId, "Check your tasks", dueSecondsAgo(5));
    const callsBefore = fakeModel.doGenerateCalls.length;

    await fireTheAlarm(ownerId);

    await vi.waitFor(() =>
      expect(sentTexts().slice(sentBefore)).toContain("Check your tasks")
    );
    expect(fakeModel.doGenerateCalls).toHaveLength(callsBefore);
    expect(await rowOf(ownerId, "Check your tasks")).toMatchObject({
      action: "send_text",
    });
  });

  it("changes the prompt of a Scheduled Task at the limit of active Scheduled Tasks", async () => {
    const ownerId = await ownerInWarsaw(9144);
    const { maxActiveScheduledTasks } = defaultBehaviorConfig;
    await Promise.all(
      Array.from({ length: maxActiveScheduledTasks }, (_, index) =>
        seedScheduledTask(
          ownerId,
          `Task ${index}`,
          utc(`03-${String(index + 1).padStart(2, "0")}T08:00:00.000`)
        )
      )
    );
    const { schedule_id: scheduleId } = await rowOf(ownerId, "Task 0");
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: {
          scheduleId,
          action: { _tag: "RunPrompt", prompt: "Reworded task" },
        },
      },
      { say: "Changed" },
    ]);

    await askAndWaitForReply(9144, "reword the first task");

    const [call] = await toolCallsOf(ownerId);
    expect(call?.failed).toBe(false);
    expect(await rowOf(ownerId, "Reworded task")).toMatchObject({
      state: "active",
    });
  });

  it("cancels a Scheduled Task, and it does not fire", async () => {
    const ownerId = await ownerInWarsaw(9145);
    await seedScheduledTask(ownerId, "list my tasks", dueSecondsAgo(5));
    const { schedule_id: scheduleId } = await rowOf(ownerId, "list my tasks");
    scriptModel([
      { callTool: cancelScheduleToolName, input: { scheduleId } },
      { say: "Cancelled" },
    ]);
    await askAndWaitForReply(9145, "cancel the task");
    const sentBefore = fakeTelegram.sent.length;
    const callsBefore = fakeModel.doGenerateCalls.length;

    await fireTheAlarm(ownerId);

    expect(await rowOf(ownerId, "list my tasks")).toMatchObject({
      state: "cancelled",
    });
    expect(sentTexts().slice(sentBefore)).toEqual([]);
    expect(fakeModel.doGenerateCalls).toHaveLength(callsBefore);
    expect(await scheduleJournalOf(ownerId)).toContainEqual({
      tag: "ScheduleCancelled",
      scheduleId,
    });
  });
});
