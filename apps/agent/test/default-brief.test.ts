import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import type { OwnerChannelConversation } from "../src/personal-agent/owner-channel-conversation.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { ProactiveMessages } from "../src/proactive/proactive-messages.ts";
import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import { cancelScheduleToolName } from "../src/schedule/cancel-schedule-tool.ts";
import type { Schedules } from "../src/schedule/schedules.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  failModel,
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  action: string;
  set_by: string;
  text: string;
  state: string;
  recurrence: string | null;
  recurrence_time_zone: string | null;
  next_due_at: string;
}

interface ProactiveMessageRow extends Record<string, SqlStorageValue> {
  event_id: string;
  sent_message_id: string | null;
  open_loop_ids: string;
  outcome: string | null;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    | Inbox
    | Journal
    | Notes
    | OwnerChannelConversation
    | ProactiveMessages
    | Schedules
    | TurnTraces
    | UsageLedger
  >
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const schedulesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ScheduleRow>(
        "SELECT schedule_id, action, set_by, text, state, recurrence, recurrence_time_zone, next_due_at FROM schedules ORDER BY created_at"
      )
      .toArray()
  );

const proactiveRowsOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ProactiveMessageRow>(
        "SELECT event_id, sent_message_id, open_loop_ids, outcome FROM proactive_messages"
      )
      .toArray()
  );

const journalTagsOf = async (ownerId: string) => {
  const entries = await inAgent(
    ownerId,
    Journal.pipe(Effect.flatMap((journal) => journal.read))
  );
  return entries.map((entry) => entry.record._tag);
};

const firstScheduleDueAt = async (ownerId: string) => {
  const [first] = await schedulesOf(ownerId);
  return first?.next_due_at ?? "";
};

const isInTheFuture = (dueAt: string) =>
  DateTime.isGreaterThan(DateTime.makeUnsafe(dueAt), DateTime.nowUnsafe());

const ownerSetsTimeZone = async (
  telegramUserId: number,
  timeZone: string,
  sentSoFar: number
) => {
  scriptModel([
    { callTool: setTimeZoneToolName, input: { timeZone } },
    { say: "Done" },
  ]);
  await telegramWebhook(
    textUpdate({ fromUserId: telegramUserId, text: `I live in ${timeZone}` })
  );
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sentSoFar + 1));
};

const makeBriefDue = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent'",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      )
    );
    return instance.fireDueSchedules();
  });

const ownerWithBrief = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  await ownerSetsTimeZone(telegramUserId, "Europe/Warsaw", 0);
  return ownerId;
};

const keepOpenLoop = (ownerId: string, text: string) =>
  inAgent(
    ownerId,
    Notes.pipe(
      Effect.flatMap((notes) =>
        notes.capture({
          text,
          source: {
            eventId: `source-${text}`,
            channel: "telegram",
            conversationId: "1",
            channelMessageId: "1",
            trustLevel: "owner",
          },
          openLoop: { kind: "task" },
        })
      )
    )
  ).then(({ note }) => note);

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

describe("creating the Brief", () => {
  it("creates one active Daily RunPrompt Schedule set by the agent at 08:00 local, with a Journal Entry", async () => {
    const ownerId = await ownerWithBrief(9601);

    const rows = await schedulesOf(ownerId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "run_prompt",
      set_by: "agent",
      text: briefPrompt,
      state: "active",
      recurrence_time_zone: "Europe/Warsaw",
    });
    expect(JSON.parse(rows[0]?.recurrence ?? "")).toEqual({
      _tag: "Daily",
      time: "08:00",
    });
    const dueAt = DateTime.setZone(
      DateTime.makeUnsafe(rows[0]?.next_due_at ?? ""),
      DateTime.zoneMakeNamedUnsafe("Europe/Warsaw")
    );
    expect(DateTime.toParts(dueAt)).toMatchObject({ hour: 8, minute: 0 });
    const tags = await journalTagsOf(ownerId);
    expect(tags.filter((tag) => tag === "BriefCreated")).toHaveLength(1);
  });

  it("creates no second Brief when the time zone changes again", async () => {
    const ownerId = await ownerWithBrief(9602);

    await ownerSetsTimeZone(9602, "America/New_York", 1);

    const rows = await schedulesOf(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recurrence_time_zone).toBe("America/New_York");
  });

  it("does not create the Brief again after it was cancelled", async () => {
    const ownerId = await ownerWithBrief(9603);
    const [brief] = await schedulesOf(ownerId);
    scriptModel([
      {
        callTool: cancelScheduleToolName,
        input: { scheduleId: brief?.schedule_id },
      },
      { say: "Cancelled" },
    ]);
    await telegramWebhook(
      textUpdate({ fromUserId: 9603, text: "no more morning briefs" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    await ownerSetsTimeZone(9603, "America/New_York", 2);

    const rows = await schedulesOf(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("cancelled");
  });
});

describe("a Brief that fires", () => {
  it("runs a proactive Turn with Open Loops in reach and sends one message to the Owner Channel Conversation", async () => {
    const ownerId = await ownerWithBrief(9610);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([{ say: "Good morning. Buy a gift for Ana today." }]);

    await makeBriefDue(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(fakeTelegram.sent[1]?.body.text).toBe(
      "Good morning. Buy a gift for Ana today."
    );
    expect(fakeTelegram.sent[1]?.body.reply_parameters).toBeUndefined();
    const call = lastModelCall();
    const system = call.prompt.find((message) => message.role === "system");
    expect(system?.content).toContain("The Owner is not present.");
    expect(system?.content).toContain(`- ${note.noteId} (task`);
    expect(system?.content).toContain("Buy a gift for Ana");
    expect((call.tools ?? []).map((tool) => tool.name).toSorted()).toEqual([
      "close_open_loop",
      "list_linked_notes",
      "list_open_loops",
      "list_schedules",
      "search_notes",
    ]);
  });

  it("records the Proactive Message, the Trace, the Usage, the metric, and moves the Brief to the next day", async () => {
    const ownerId = await ownerWithBrief(9611);
    const note = await keepOpenLoop(ownerId, "Call the bank");

    await makeBriefDue(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    await vi.waitFor(async () =>
      expect(await firstScheduleDueAt(ownerId)).toSatisfy(isInTheFuture)
    );
    const [row] = await proactiveRowsOf(ownerId);
    expect(row).toMatchObject({
      sent_message_id: expect.stringMatching(/^90\d\d$/u),
      open_loop_ids: JSON.stringify([note.noteId]),
      outcome: null,
    });
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace).toMatchObject({
      task: "proactive",
      result: "proactive_message_sent",
      eventId: row?.event_id,
      tokensSpentBefore: 0,
    });
    const usage = await inAgent(
      ownerId,
      UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read))
    );
    expect(usage.map((record) => record.task)).toEqual([
      "reply",
      "reply",
      "proactive",
    ]);
    const point = fakeMetrics.dataPoints.find(
      (dataPoint) => dataPoint.blobs?.[0] === "proactive_message"
    );
    expect(point?.blobs).toEqual([
      "proactive_message",
      "sent",
      "",
      "",
      row?.event_id,
    ]);
  });

  it("sends one message when the alarm runs twice", async () => {
    const ownerId = await ownerWithBrief(9612);

    await makeBriefDue(ownerId);
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(await proactiveRowsOf(ownerId)).toHaveLength(1);
  });

  it("sends no message and no failure notice when the model fails, and the Brief moves on", async () => {
    const ownerId = await ownerWithBrief(9613);
    failModel(10);

    await makeBriefDue(ownerId);

    await vi.waitFor(
      async () =>
        expect(await firstScheduleDueAt(ownerId)).toSatisfy(isInTheFuture),
      { timeout: 10_000 }
    );
    expect(fakeTelegram.sent).toHaveLength(1);
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.at(-1)?.trace.result).toBe("proactive_message_failed");
  });
});

describe("a Brief that Telegram refuses", () => {
  it("records a proactive_message_failed Trace after the Trace of the reply and still moves the Brief on", async () => {
    const ownerId = await ownerWithBrief(9614);
    fakeTelegram.answerWith("refuse");

    await makeBriefDue(ownerId);

    await vi.waitFor(async () =>
      expect(await firstScheduleDueAt(ownerId)).toSatisfy(isInTheFuture)
    );
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
    );
    expect(traces.map(({ trace }) => trace.result).slice(-2)).toEqual([
      "proactive_message_sent",
      "proactive_message_failed",
    ]);
    expect(
      fakeMetrics.dataPoints.some(
        (point) => point.blobs?.[0] === "proactive_message"
      )
    ).toBe(false);
  });
});

const seedFiredBriefWithConfirmedSend = async (telegramUserId: number) => {
  const ownerId = await ownerWithBrief(telegramUserId);
  const agent = await agentOf(ownerId);
  const eventId = await runInDurableObject(agent, (instance, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent'",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      )
    );
    return instance.runtime.runPromise(
      Effect.gen(function* seedEffect() {
        const inbox = yield* Inbox;
        const journal = yield* Journal;
        const proactiveMessages = yield* ProactiveMessages;
        yield* storeDueScheduleEvents;
        const [event] = yield* inbox.pending;
        const firedEventId = event?.eventId ?? "";
        yield* proactiveMessages.plan(firedEventId, ["note-1"]);
        yield* journal.append({
          _tag: "ReplyPlanned",
          eventId: firedEventId,
          text: "Good morning",
        });
        yield* journal.append({
          _tag: "SendStarted",
          eventId: firedEventId,
        });
        yield* journal.append({
          _tag: "ReplySent",
          eventId: firedEventId,
          channelMessageId: "9555",
        });
        return firedEventId;
      })
    );
  });
  return { ownerId, eventId };
};

describe("a Brief after a reset", () => {
  it("sends nothing again and still records the sent message and moves to the next day", async () => {
    const { ownerId, eventId } = await seedFiredBriefWithConfirmedSend(9620);
    await abortAllDurableObjects();

    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.runTurn()
    );

    expect(fakeTelegram.sent).toHaveLength(1);
    const [row] = await proactiveRowsOf(ownerId);
    expect(row).toMatchObject({ event_id: eventId, sent_message_id: "9555" });
    expect(
      fakeMetrics.dataPoints.filter(
        (point) =>
          point.blobs?.[0] === "proactive_message" && point.blobs[4] === eventId
      )
    ).toHaveLength(1);
    const [brief] = await schedulesOf(ownerId);
    expect(
      DateTime.isGreaterThan(
        DateTime.makeUnsafe(brief?.next_due_at ?? ""),
        DateTime.nowUnsafe()
      )
    ).toBe(true);
    expect(brief?.state).toBe("active");
  });
});
