import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { searchNotesToolName } from "../src/notes/search-notes-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import type { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { skipScheduledTask } from "../src/personal-agent/scheduled-task-skip.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { changeScheduleToolName } from "../src/schedule/change-schedule-tool.ts";
import { ScheduleAlarm } from "../src/schedule/schedule-alarm.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import type { SetScheduleRequest } from "../src/schedule/schedules.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { localTimeOf } from "../src/time/local-time.ts";
import { OperatorMetrics } from "../src/tracing/operator-metrics.ts";
import { redactedMark, Redactor } from "../src/tracing/redactor.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  failModel,
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  holdModel,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ScheduledTaskServices =
  | Inbox
  | Journal
  | OwnerPreferences
  | ScheduleAlarm
  | Schedules
  | TurnTraces
  | UsageLedger;

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  action: string;
  next_due_at: string;
  state: string;
}

const prompt = "List my open tasks";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, ScheduledTaskServices>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const schedulesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ScheduleRow>(
        "SELECT schedule_id, action, next_due_at, state FROM schedules ORDER BY next_due_at"
      )
      .toArray()
  );

const sentTexts = () => fakeTelegram.sent.map((sent) => sent.body.text);

const fireTheAlarm = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
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
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text: "hi" }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  return ownerId;
};

const seedScheduledTask = (
  ownerId: string,
  repeat?: SetScheduleRequest["repeat"],
  dueAgo?: Partial<DateTime.DateTime.PartsForMath>
) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      const { schedule } = yield* schedules.set({
        action: { _tag: "RunPrompt", prompt },
        setBy: "owner",
        dueAt: DateTime.subtract(now, dueAgo ?? { seconds: 5 }),
        repeat,
        sourceEventId: "seed-scheduled-task",
      });
      yield* (yield* ScheduleAlarm).rearm;
      return schedule;
    })
  );

const lastModelCall = () => {
  const call = fakeModel.doGenerateCalls.at(-1);
  if (call === undefined) {
    throw new Error("The model was not called");
  }
  return call;
};

beforeEach(() => {
  resetFakes();
});

describe("a one-time Scheduled Task", () => {
  it("runs at its due time and sends one message from the model result, with no message to reply to", async () => {
    const ownerId = await ownerInWarsaw(9401);
    await seedScheduledTask(ownerId);

    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(`You said: ${prompt}`);
    expect(fakeTelegram.sent[1]?.body.reply_parameters).toBeUndefined();
    const [row] = await schedulesOf(ownerId);
    expect(row?.state).toBe("done");
    expect(fakeTelegram.sent).toHaveLength(2);
  });
});

describe("a Daily Scheduled Task", () => {
  it("runs and then moves to its next occurrence", async () => {
    const ownerId = await ownerInWarsaw(9402);
    const schedule = await seedScheduledTask(ownerId, {
      rule: { _tag: "Daily", time: "08:00" },
      timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"),
    });

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const [row] = await schedulesOf(ownerId);
    expect(row?.state).toBe("active");
    expect(
      DateTime.isGreaterThan(
        DateTime.makeUnsafe(row?.next_due_at ?? ""),
        DateTime.nowUnsafe()
      )
    ).toBe(true);
    expect(row?.next_due_at).not.toBe(DateTime.formatIso(schedule.nextDueAt));
  });
});

describe("the tools of a Scheduled Task Turn", () => {
  it("gives the model exactly the three read tools", async () => {
    const ownerId = await ownerInWarsaw(9403);
    await seedScheduledTask(ownerId);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const names = (lastModelCall().tools ?? []).map((tool) => tool.name);
    expect(names.toSorted()).toEqual([
      "list_linked_notes",
      "list_schedules",
      "search_notes",
    ]);
  });

  it("creates no Schedule when the model asks for set_schedule", async () => {
    const ownerId = await ownerInWarsaw(9404);
    await seedScheduledTask(ownerId);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          action: { _tag: "RunPrompt", prompt: "Again" },
          localDueTime: "2099-01-01T09:00",
        },
      },
      { say: "Done" },
    ]);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const rows = await schedulesOf(ownerId);
    expect(rows).toHaveLength(1);
    expect(sentTexts()[1]).toBe("Done");
  });
});

describe("the system prompt of a Scheduled Task Turn", () => {
  it("says that the Owner is not present and gives the local time when the Schedule was set", async () => {
    const ownerId = await ownerInWarsaw(9408);
    const schedule = await seedScheduledTask(ownerId);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const system = lastModelCall().prompt.find(
      (message) => message.role === "system"
    );
    const setAt = localTimeOf(
      schedule.createdAt,
      DateTime.zoneMakeNamedUnsafe("Europe/Warsaw")
    );
    expect(system?.content).toContain("The Owner is not present.");
    expect(system?.content).toContain(`set at ${setAt} (Europe/Warsaw)`);
  });
});

describe("the Conversation history of a Scheduled Task", () => {
  it("gives the next reply Turn the prompt and the result", async () => {
    const ownerId = await ownerInWarsaw(9405);
    await seedScheduledTask(ownerId);
    await fireTheAlarm(ownerId);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    await telegramWebhook(
      textUpdate({ fromUserId: 9405, text: "thanks, and tomorrow?" })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));
    const messages = JSON.stringify(lastModelCall().prompt);
    expect(messages).toContain(prompt);
    expect(messages).toContain(`You said: ${prompt}`);
  });
});

const jsonTextOf = (text: string) => JSON.stringify(text).slice(1, -1);

describe("the Conversation history of a skipped or failed Scheduled Task", () => {
  it("gives the next reply Turn the prompt and the skip notice", async () => {
    const ownerId = await ownerInWarsaw(9450);
    await recordUsage(ownerId, "scheduled_task", scheduledTaskDailyTokenBudget);
    await seedScheduledTask(ownerId);
    await fireTheAlarm(ownerId);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    await telegramWebhook(
      textUpdate({ fromUserId: 9450, text: "why did you skip that?" })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));
    const messages = JSON.stringify(lastModelCall().prompt);
    expect(messages).toContain(prompt);
    expect(messages).toContain(jsonTextOf(skipMessage));
  });

  it("gives the next reply Turn the failure notice", async () => {
    const ownerId = await ownerInWarsaw(9451);
    failModel(3);
    await seedScheduledTask(ownerId);
    await fireTheAlarm(ownerId);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
      timeout: 10_000,
    });

    await telegramWebhook(
      textUpdate({ fromUserId: 9451, text: "what happened?" })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));
    expect(JSON.stringify(lastModelCall().prompt)).toContain(
      jsonTextOf(failureMessage)
    );
  });

  it("keeps the failure notice in the history when the reset comes after the send was confirmed", async () => {
    const ownerId = await ownerInWarsaw(9454);
    const schedule = await seedScheduledTask(ownerId);
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          Effect.gen(function* confirmedFailureEffect() {
            yield* journal.append({
              _tag: "TurnFailed",
              eventId,
              reason: "model down",
            });
            yield* journal.append({
              _tag: "ReplyPlanned",
              eventId,
              text: failureMessage,
            });
            yield* journal.append({ _tag: "SendStarted", eventId });
            yield* journal.append({
              _tag: "ReplySent",
              eventId,
              channelMessageId: "9000",
            });
          })
        )
      )
    );
    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await vi.waitFor(async () =>
      expect(
        await runInDurableObject(await agentOf(ownerId), (_, state) =>
          state.storage.sql
            .exec(
              "SELECT event_id FROM conversation_recorded_events WHERE event_id = ?",
              `${eventId}:failure-notice`
            )
            .toArray()
        )
      ).toHaveLength(1)
    );

    await telegramWebhook(
      textUpdate({ fromUserId: 9454, text: "what happened?" })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(JSON.stringify(lastModelCall().prompt)).toContain(
      jsonTextOf(failureMessage)
    );
  });

  it("saves no secret from the prompt when the reset comes after the confirmed send of a skip notice", async () => {
    const ownerId = await ownerInWarsaw(9455);
    const schedule = await seedSecretPrompt(ownerId);
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          Effect.gen(function* confirmedSkipEffect() {
            yield* journal.append({
              _tag: "ScheduledTaskSkipped",
              eventId,
              scheduleId: schedule.scheduleId,
              dueAt: DateTime.formatIso(schedule.nextDueAt),
              dailyTokenBudget: scheduledTaskDailyTokenBudget,
              tokensSpent: scheduledTaskDailyTokenBudget,
            });
            yield* journal.append({
              _tag: "ReplyPlanned",
              eventId,
              text: "skipped",
            });
            yield* journal.append({ _tag: "SendStarted", eventId });
            yield* journal.append({
              _tag: "ReplySent",
              eventId,
              channelMessageId: "9000",
            });
          })
        )
      )
    );
    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);

    const saved = async () =>
      runInDurableObject(await agentOf(ownerId), (_, state) =>
        state.storage.sql
          .exec<{ message: string }>(
            "SELECT message FROM conversation_messages"
          )
          .toArray()
          .map((row) => row.message)
          .join(" ")
      );
    await vi.waitFor(async () => expect(await saved()).toContain("skipped"));
    expect(await saved()).toContain(redactedMark);
    expect(await saved()).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it("keeps the skip notice in the history when the reset comes after the skip decision", async () => {
    const ownerId = await ownerInWarsaw(9452);
    const schedule = await seedScheduledTask(ownerId);
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          journal.append({
            _tag: "ScheduledTaskSkipped",
            eventId,
            scheduleId: schedule.scheduleId,
            dueAt: DateTime.formatIso(schedule.nextDueAt),
            dailyTokenBudget: scheduledTaskDailyTokenBudget,
            tokensSpent: scheduledTaskDailyTokenBudget,
          })
        )
      )
    );
    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    await telegramWebhook(
      textUpdate({ fromUserId: 9452, text: "why did you skip that?" })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));
    const messages = JSON.stringify(lastModelCall().prompt);
    expect(messages).toContain(prompt);
    expect(messages).toContain(jsonTextOf(skipMessage));
  });
});

describe("the records of a Scheduled Task Turn", () => {
  it("writes a Trace, Usage under scheduled_task, and Journal Entries with the Schedule id", async () => {
    const ownerId = await ownerInWarsaw(9406);
    const schedule = await seedScheduledTask(ownerId);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({
      task: "scheduled_task",
      result: "scheduled_task_replied",
      scheduleId: schedule.scheduleId,
      reply: `You said: ${prompt}`,
    });
    const usage = await inAgent(
      ownerId,
      UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read))
    );
    expect(usage.map((record) => record.task)).toEqual([
      "reply",
      "scheduled_task",
    ]);
    const entries = await inAgent(
      ownerId,
      Journal.pipe(Effect.flatMap((journal) => journal.read))
    );
    const completed = entries.find(
      (entry) => entry.record._tag === "ScheduleCompleted"
    );
    expect(completed?.record).toMatchObject({
      scheduleId: schedule.scheduleId,
    });
    const turnPoint = fakeMetrics.dataPoints.find(
      (point) =>
        point.blobs?.[0] === "turn" &&
        point.blobs[4] === completed?.record.eventId
    );
    expect(turnPoint).toBeDefined();
  });
});

describe("set_schedule with the RunPrompt Action", () => {
  it("stores an active run_prompt Schedule with the prompt as its text", async () => {
    const ownerId = await ownerInWarsaw(9407);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          action: { _tag: "RunPrompt", prompt },
          repeat: { _tag: "Daily", time: "08:00" },
        },
      },
      { say: "Set" },
    ]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9407, text: "every day at 8, list my tasks" })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const [row] = await schedulesOf(ownerId);
    expect(row).toMatchObject({ action: "run_prompt", state: "active" });
  });
});

const journalOf = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record))
    )
  );

const journalTagsOf = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record._tag))
    )
  );

const lastTraceOf = (ownerId: string) =>
  inAgent(
    ownerId,
    TurnTraces.pipe(
      Effect.flatMap((stored) => stored.read),
      Effect.map((traces) => traces.at(-1)?.trace)
    )
  );

const failureMessage = `Your Scheduled Task "${prompt}" did not run. I could not finish it this time.`;

describe("a Scheduled Task that fails", () => {
  it("sends the failure message, records the failure in the Trace, and moves a Daily Schedule to its next occurrence", async () => {
    const ownerId = await ownerInWarsaw(9410);
    failModel(3);
    const schedule = await seedScheduledTask(ownerId, {
      rule: { _tag: "Daily", time: "08:00" },
      timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"),
    });

    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
      timeout: 10_000,
    });
    expect(sentTexts()[1]).toBe(failureMessage);
    expect(fakeTelegram.sent[1]?.body.reply_parameters).toBeUndefined();
    const [row] = await schedulesOf(ownerId);
    expect(row?.state).toBe("active");
    expect(row?.next_due_at).not.toBe(DateTime.formatIso(schedule.nextDueAt));
    expect(
      DateTime.isGreaterThan(
        DateTime.makeUnsafe(row?.next_due_at ?? ""),
        DateTime.nowUnsafe()
      )
    ).toBe(true);
    expect(await lastTraceOf(ownerId)).toMatchObject({
      task: "scheduled_task",
      result: "scheduled_task_failed",
      scheduleId: schedule.scheduleId,
      reply: null,
    });
    expect(await journalOf(ownerId)).toContainEqual(
      expect.objectContaining({ _tag: "TurnFailed" })
    );
    expect(sentTexts()).toHaveLength(2);
  });

  it("marks a one-time Scheduled Task done after the failure message", async () => {
    const ownerId = await ownerInWarsaw(9411);
    failModel(3);
    await seedScheduledTask(ownerId);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
      timeout: 10_000,
    });
    const [row] = await schedulesOf(ownerId);
    expect(row?.state).toBe("done");
  });

  it("sends the failure message when the model reaches the step limit", async () => {
    const ownerId = await ownerInWarsaw(9412);
    await seedScheduledTask(ownerId);
    scriptModel(
      Array.from({ length: defaultBehaviorConfig.maxToolSteps + 4 }, () => ({
        callTool: searchNotesToolName,
        input: { query: "tasks" },
      }))
    );

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
      timeout: 10_000,
    });
    expect(sentTexts()[1]).toBe(failureMessage);
    expect(await lastTraceOf(ownerId)).toMatchObject({
      result: "scheduled_task_failed",
    });
  });

  it("names a long prompt in a shortened form", async () => {
    const ownerId = await ownerInWarsaw(9413);
    const longPrompt = `${"a".repeat(100)} end`;
    failModel(3);
    await inAgent(
      ownerId,
      Effect.gen(function* seedEffect() {
        const schedules = yield* Schedules;
        const now = yield* DateTime.now;
        yield* schedules.set({
          action: { _tag: "RunPrompt", prompt: longPrompt },
          setBy: "owner",
          dueAt: DateTime.subtract(now, { seconds: 5 }),
          sourceEventId: "seed-long-prompt",
        });
        yield* (yield* ScheduleAlarm).rearm;
      })
    );

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
      timeout: 10_000,
    });
    expect(sentTexts()[1]).toBe(
      `Your Scheduled Task "${"a".repeat(80)}..." did not run. I could not finish it this time.`
    );
  });
});

describe("a late Scheduled Task", () => {
  it("sends the result with no late text inside the grace period", async () => {
    const ownerId = await ownerInWarsaw(9414);
    await seedScheduledTask(ownerId, undefined, { minutes: 4 });

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(`You said: ${prompt}`);
    expect(await journalTagsOf(ownerId)).not.toContain("ReminderLate");
  });

  it("starts the result with the late text after the grace period", async () => {
    const ownerId = await ownerInWarsaw(9415);
    const schedule = await seedScheduledTask(ownerId, undefined, { hours: 2 });
    const dueLocal = localTimeOf(
      schedule.nextDueAt,
      DateTime.zoneMakeNamedUnsafe("Europe/Warsaw")
    );

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(
      `This Scheduled Task is late. It was due ${dueLocal} (Europe/Warsaw): You said: ${prompt}`
    );
    expect(await journalTagsOf(ownerId)).toContain("ReminderLate");
  });
});

const eventIdOfFire = async (ownerId: string, scheduleId: string) => {
  const entries = await journalOf(ownerId);
  const fired = entries.find(
    (record) =>
      record._tag === "ScheduleFired" && record.scheduleId === scheduleId
  );
  return fired?.eventId ?? "";
};

describe("a Scheduled Task after a reset of the Durable Object", () => {
  it("sends no second message when the reset comes after the SendStarted Journal Entry", async () => {
    const ownerId = await ownerInWarsaw(9416);
    const schedule = await seedScheduledTask(ownerId);
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          Effect.gen(function* startedEffect() {
            yield* journal.append({
              _tag: "ReplyPlanned",
              eventId,
              text: "maybe sent",
            });
            yield* journal.append({ _tag: "SendStarted", eventId });
          })
        )
      )
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await journalTagsOf(ownerId)).toContain("ReplyFailed")
    );
    expect(sentTexts()).toEqual(["You said: hi"]);
    expect(fakeModel.doGenerateCalls).toHaveLength(1);
  });

  it("continues from the recorded steps and sends one message when the reset comes before the model call finishes", async () => {
    const ownerId = await ownerInWarsaw(9417);
    await seedScheduledTask(ownerId);
    scriptModel([
      { callTool: searchNotesToolName, input: { query: "tasks" } },
      { say: "Your tasks are done" },
    ]);
    const callsBefore = fakeModel.doGenerateCalls.length;
    const release = holdModel(callsBefore + 1);

    await fireTheAlarm(ownerId);
    await vi.waitFor(() =>
      expect(fakeModel.doGenerateCalls.length).toBe(callsBefore + 2)
    );
    await abortAllDurableObjects();
    release();
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe("Your tasks are done");
    await fireTheAlarm(ownerId);
    expect(fakeTelegram.sent).toHaveLength(2);
    const prompts = JSON.stringify(lastModelCall().prompt);
    expect(prompts).toContain("tool-result");
  });

  it("sends the failure message of the task when the reset comes after TurnFailed and before the send", async () => {
    const ownerId = await ownerInWarsaw(9418);
    const schedule = await seedScheduledTask(ownerId, {
      rule: { _tag: "Daily", time: "08:00" },
      timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"),
    });
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          journal.append({ _tag: "TurnFailed", eventId, reason: "model down" })
        )
      )
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(failureMessage);
    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    const [row] = await schedulesOf(ownerId);
    expect(row?.next_due_at).not.toBe(DateTime.formatIso(schedule.nextDueAt));
  });
});

const secretPrompt = () => `check ${env.TELEGRAM_BOT_TOKEN} now`;

const seedSecretPrompt = (ownerId: string) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      const { schedule } = yield* schedules.set({
        action: { _tag: "RunPrompt", prompt: secretPrompt() },
        setBy: "owner",
        dueAt: DateTime.subtract(now, { seconds: 5 }),
        sourceEventId: "seed-secret-prompt",
      });
      yield* (yield* ScheduleAlarm).rearm;
      return schedule;
    })
  );

describe("the failure message of a Scheduled Task with a secret in its prompt", () => {
  const redactedFailureMessage = `Your Scheduled Task "check ${redactedMark} now" did not run. I could not finish it this time.`;

  it("redacts the secret when the model fails", async () => {
    const ownerId = await ownerInWarsaw(9419);
    failModel(3);
    await seedSecretPrompt(ownerId);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
      timeout: 10_000,
    });
    expect(sentTexts()[1]).toBe(redactedFailureMessage);
    expect(JSON.stringify(await journalOf(ownerId))).not.toContain(
      env.TELEGRAM_BOT_TOKEN
    );
  });

  it("redacts the secret when a reset comes after TurnFailed and before the send", async () => {
    const ownerId = await ownerInWarsaw(9420);
    const schedule = await seedSecretPrompt(ownerId);
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          journal.append({ _tag: "TurnFailed", eventId, reason: "model down" })
        )
      )
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(redactedFailureMessage);
    expect(JSON.stringify(await journalOf(ownerId))).not.toContain(
      env.TELEGRAM_BOT_TOKEN
    );
  });
});

const { scheduledTaskDailyTokenBudget, maxActiveScheduledTasks } =
  defaultBehaviorConfig;

const skipMessage = `Your Scheduled Task "${prompt}" was skipped because of the daily limit for Scheduled Tasks.`;

const recordUsage = (
  ownerId: string,
  task: "reply" | "scheduled_task",
  inputTokens: number
) =>
  inAgent(
    ownerId,
    UsageLedger.pipe(
      Effect.flatMap((ledger) =>
        ledger.record(task, "model", {
          inputTokens,
          outputTokens: 0,
          cachedInputTokens: undefined,
          costUsd: undefined,
        })
      )
    )
  );

const skipPointsOf = (eventId: string) =>
  fakeMetrics.dataPoints.filter(
    (point) =>
      point.blobs?.[0] === "scheduled_task_skipped" &&
      point.blobs[4] === eventId
  );

describe("the daily Token Budget of Scheduled Tasks", () => {
  it("makes no model call when the Budget is spent, sends the skip message, and moves a Daily Schedule on", async () => {
    const ownerId = await ownerInWarsaw(9440);
    await recordUsage(ownerId, "scheduled_task", scheduledTaskDailyTokenBudget);
    const calls = fakeModel.doGenerateCalls.length;
    await seedScheduledTask(ownerId, {
      rule: { _tag: "Daily", time: "08:00" },
      timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"),
    });
    const [before] = await schedulesOf(ownerId);

    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(skipMessage);
    expect(fakeModel.doGenerateCalls).toHaveLength(calls);
    const [after] = await schedulesOf(ownerId);
    expect(after?.state).toBe("active");
    expect(after?.next_due_at).not.toBe(before?.next_due_at);
    expect((after?.next_due_at ?? "") > (before?.next_due_at ?? "")).toBe(true);
    expect(await journalTagsOf(ownerId)).toContain("ScheduledTaskSkipped");
    const skipTrace = await lastTraceOf(ownerId);
    expect(skipTrace?.eventId).not.toBe("");
    expect(
      fakeMetrics.dataPoints.some(
        (point) =>
          point.blobs?.[0] === "scheduled_task_skipped" &&
          point.blobs[4] === skipTrace?.eventId
      )
    ).toBe(true);
    expect(await lastTraceOf(ownerId)).toMatchObject({
      result: "scheduled_task_skipped",
      dailyTokenBudget: scheduledTaskDailyTokenBudget,
      tokensSpent: scheduledTaskDailyTokenBudget,
    });
  });

  it("sends the skip message and moves the Schedule on when the reset comes after ScheduledTaskSkipped and before the send", async () => {
    const ownerId = await ownerInWarsaw(9448);
    const schedule = await seedScheduledTask(ownerId, {
      rule: { _tag: "Daily", time: "08:00" },
      timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"),
    });
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          journal.append({
            _tag: "ScheduledTaskSkipped",
            eventId,
            scheduleId: schedule.scheduleId,
            dueAt: DateTime.formatIso(schedule.nextDueAt),
            dailyTokenBudget: scheduledTaskDailyTokenBudget,
            tokensSpent: scheduledTaskDailyTokenBudget,
          })
        )
      )
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(skipMessage);
    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(await lastTraceOf(ownerId)).toMatchObject({
      result: "scheduled_task_skipped",
      tokensSpent: scheduledTaskDailyTokenBudget,
    });
    expect(skipPointsOf(eventId)).toHaveLength(1);
    const [row] = await schedulesOf(ownerId);
    expect(row?.next_due_at).not.toBe(DateTime.formatIso(schedule.nextDueAt));
    expect(fakeTelegram.sent).toHaveLength(2);
  });

  it("repeats the skip metric with the same Event id when a reset comes between the metric write and the Trace write", async () => {
    const ownerId = await ownerInWarsaw(9449);
    await recordUsage(ownerId, "scheduled_task", scheduledTaskDailyTokenBudget);
    const schedule = await seedScheduledTask(ownerId, {
      rule: { _tag: "Daily", time: "08:00" },
      timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"),
    });
    await inAgent(ownerId, storeDueScheduleEvents);
    const eventId = await eventIdOfFire(ownerId, schedule.scheduleId);
    await inAgent(
      ownerId,
      TurnTraces.pipe(
        Effect.flatMap((traces) =>
          Effect.exit(
            skipScheduledTask({
              ownerId: OwnerIdSchema.make(ownerId),
              event: {
                _tag: "ScheduleFired",
                eventId,
                scheduleId: schedule.scheduleId,
                dueAt: DateTime.formatIso(schedule.nextDueAt),
                state: "pending",
              },
              action: { _tag: "RunPrompt", prompt },
              dailyTokenBudget: scheduledTaskDailyTokenBudget,
              tokensSpent: scheduledTaskDailyTokenBudget,
              startedAt: 0,
            }).pipe(
              Effect.provideService(TurnTraces, {
                ...traces,
                record: () => Effect.die("The Durable Object reset"),
              })
            )
          )
        ),
        Effect.provide(
          Layer.mergeAll(
            OperatorMetrics.layer(fakeMetrics.dataset),
            Redactor.layer([])
          )
        )
      ) as never
    );
    expect(skipPointsOf(eventId)).toHaveLength(1);

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(skipPointsOf(eventId)).toHaveLength(2);
    expect(await lastTraceOf(ownerId)).toMatchObject({
      result: "scheduled_task_skipped",
    });
  });

  it("completes a one-time Scheduled Task that is skipped", async () => {
    const ownerId = await ownerInWarsaw(9441);
    await recordUsage(ownerId, "scheduled_task", scheduledTaskDailyTokenBudget);
    await seedScheduledTask(ownerId);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const [row] = await schedulesOf(ownerId);
    expect(row?.state).toBe("done");
  });

  it("does not count the tokens of reply Turns, and runs the task below the Budget", async () => {
    const ownerId = await ownerInWarsaw(9442);
    await recordUsage(ownerId, "reply", scheduledTaskDailyTokenBudget * 5);
    await recordUsage(
      ownerId,
      "scheduled_task",
      scheduledTaskDailyTokenBudget - 1
    );
    await seedScheduledTask(ownerId);

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toBe(`You said: ${prompt}`);
  });

  it("puts the prompt of a skipped task through the Redactor", async () => {
    const ownerId = await ownerInWarsaw(9443);
    await recordUsage(ownerId, "scheduled_task", scheduledTaskDailyTokenBudget);
    await inAgent(
      ownerId,
      Effect.gen(function* seedSecretEffect() {
        const schedules = yield* Schedules;
        yield* schedules.set({
          action: {
            _tag: "RunPrompt",
            prompt: `Use ${env.TELEGRAM_BOT_TOKEN}`,
          },
          setBy: "owner",
          dueAt: DateTime.subtract(yield* DateTime.now, { seconds: 5 }),
          sourceEventId: "seed-secret-task",
        });
        yield* (yield* ScheduleAlarm).rearm;
      })
    );

    await fireTheAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(sentTexts()[1]).toContain(redactedMark);
    expect(sentTexts()[1]).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
});

const seedActiveScheduledTasks = (ownerId: string, howMany: number) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedManyEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      for (let index = 0; index < howMany; index += 1) {
        yield* schedules.set({
          action: { _tag: "RunPrompt", prompt: `Task ${index}` },
          setBy: "owner",
          dueAt: DateTime.add(now, { days: 30 + index }),
          sourceEventId: `seed-many-${index}`,
        });
      }
    })
  );

describe("the limit of active Scheduled Tasks", () => {
  it("refuses a new RunPrompt Schedule at the limit with a message for the model", async () => {
    const ownerId = await ownerInWarsaw(9444);
    await seedActiveScheduledTasks(ownerId, maxActiveScheduledTasks);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          action: { _tag: "RunPrompt", prompt },
          localDueTime: "2099-01-01T09:00",
        },
      },
      { say: "Too many" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 9444, text: "add one" }));

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(await schedulesOf(ownerId)).toHaveLength(maxActiveScheduledTasks);
    const trace = await lastTraceOf(ownerId);
    const call =
      trace?.task === "reply" ? trace.steps[0]?.toolCalls[0] : undefined;
    expect(call?.failed).toBe(true);
    expect(call?.output).toContain(
      `${maxActiveScheduledTasks} active Scheduled Tasks`
    );
  });

  it("accepts a SendText Schedule at the limit", async () => {
    const ownerId = await ownerInWarsaw(9445);
    await seedActiveScheduledTasks(ownerId, maxActiveScheduledTasks);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          action: { _tag: "SendText", text: "Call mom" },
          localDueTime: "2099-01-01T09:00",
        },
      },
      { say: "Set" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 9445, text: "remind me" }));

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(await schedulesOf(ownerId)).toHaveLength(
      maxActiveScheduledTasks + 1
    );
  });

  it("accepts a RunPrompt Schedule below the limit", async () => {
    const ownerId = await ownerInWarsaw(9446);
    await seedActiveScheduledTasks(ownerId, maxActiveScheduledTasks - 1);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          action: { _tag: "RunPrompt", prompt },
          localDueTime: "2099-01-01T09:00",
        },
      },
      { say: "Set" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 9446, text: "add one" }));

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(await schedulesOf(ownerId)).toHaveLength(maxActiveScheduledTasks);
  });

  it("refuses to change a SendText Schedule into a Scheduled Task at the limit", async () => {
    const ownerId = await ownerInWarsaw(9447);
    await seedActiveScheduledTasks(ownerId, maxActiveScheduledTasks);
    const reminder = await inAgent(
      ownerId,
      Effect.gen(function* seedReminderEffect() {
        const schedules = yield* Schedules;
        const { schedule } = yield* schedules.set({
          action: { _tag: "SendText", text: "Call mom" },
          setBy: "owner",
          dueAt: DateTime.add(yield* DateTime.now, { days: 5 }),
          sourceEventId: "seed-reminder",
        });
        return schedule;
      })
    );
    scriptModel([
      {
        callTool: changeScheduleToolName,
        input: {
          scheduleId: reminder.scheduleId,
          action: { _tag: "RunPrompt", prompt },
        },
      },
      { say: "Too many" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 9447, text: "change it" }));

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const rows = await schedulesOf(ownerId);
    expect(rows.filter((row) => row.action === "run_prompt")).toHaveLength(
      maxActiveScheduledTasks
    );
  });
});

describe("the query of the daily Token Budget", () => {
  it("uses the index of Owner, Model Task, and time", async () => {
    const ownerId = await ownerInWarsaw(9453);

    const plan = await runInDurableObject(await agentOf(ownerId), (_, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT sum(input_tokens), sum(output_tokens) FROM model_usage WHERE owner_id = ? AND task = ? AND recorded_at >= ?",
          ownerId,
          "scheduled_task",
          "2027-01-01T00:00:00.000Z"
        )
        .toArray()
    );

    const details = plan.map((row) => row.detail).join(" ");
    expect(details).toContain("model_usage_budget");
    expect(details).not.toContain("SCAN");
  });
});
