import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import type { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { ScheduleAlarm } from "../src/schedule/schedule-alarm.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import type { SetScheduleRequest } from "../src/schedule/schedules.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  fakeMetrics,
  fakeModel,
  fakeTelegram,
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
  repeat?: SetScheduleRequest["repeat"]
) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      const { schedule } = yield* schedules.set({
        action: { _tag: "RunPrompt", prompt },
        setBy: "owner",
        dueAt: DateTime.subtract(now, { seconds: 5 }),
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
    expect(
      fakeMetrics.dataPoints.some((point) => point.blobs?.[0] === "turn")
    ).toBe(true);
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
