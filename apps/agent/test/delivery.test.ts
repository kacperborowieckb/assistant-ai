import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Channel } from "../src/channels/channel.ts";
import type { Delivery } from "../src/channels/channel.ts";
import { Journal } from "../src/journal/journal.ts";
import type { JournalEntry, JournalRecord } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import type { Conversation } from "../src/personal-agent/conversation.ts";
import {
  deliveryStateOf,
  deliveryStateOfEntries,
  fail,
  failWithNotice,
  honestFailureText,
  noOwnerConversationReason,
  recordOutcome,
  recordUnconfirmedSend,
  send,
  unconfirmedSendReason,
} from "../src/personal-agent/delivery.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { OwnerChannelConversation } from "../src/personal-agent/owner-channel-conversation.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { OperatorMetrics } from "../src/tracing/operator-metrics.ts";
import { Redactor } from "../src/tracing/redactor.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeMetrics, fakeTelegram, resetFakes } from "./fakes.ts";
import { addOwner } from "./telegram-requests.ts";

const entriesOf = (records: readonly JournalRecord[]): JournalEntry[] =>
  records.map((record, sequence) => ({
    sequence,
    ownerId: OwnerIdSchema.make("owner"),
    recordedAt: "2026-01-01T00:00:00.000Z",
    record,
  }));

const eventId = "event-1";

const planned: JournalRecord = {
  _tag: "ReplyPlanned",
  eventId,
  text: "planned text",
};
const started: JournalRecord = { _tag: "SendStarted", eventId };
const sent: JournalRecord = {
  _tag: "ReplySent",
  eventId,
  channelMessageId: "9100",
};
const refused: JournalRecord = {
  _tag: "ReplyFailed",
  eventId,
  reason: "refused",
};
const turnFailed: JournalRecord = {
  _tag: "TurnFailed",
  eventId,
  reason: "model down",
};

const stateAfter = (...records: readonly JournalRecord[]) =>
  deliveryStateOfEntries(entriesOf(records));

describe("the Delivery state of an Event", () => {
  it("is Unsent with no delivery entries, and after a reset following ReplyPlanned", () => {
    expect(stateAfter()).toEqual({ _tag: "Unsent" });
    expect(stateAfter(planned)).toEqual({ _tag: "Unsent" });
  });

  it("is Sent after ReplySent, also when the reset comes before completion", () => {
    expect(stateAfter(planned, started, sent)).toEqual({
      _tag: "Sent",
      text: "planned text",
      channelMessageId: "9100",
    });
  });

  it("is SendFailed after a refused send that has no recorded failed Turn", () => {
    expect(stateAfter(planned, started, refused)).toEqual({
      _tag: "SendFailed",
      text: "planned text",
      reason: "refused",
    });
  });

  it("is Unconfirmed after a reset that follows SendStarted", () => {
    expect(stateAfter(planned, started)).toEqual({
      _tag: "Unconfirmed",
      text: "planned text",
    });
  });

  it("is FailedNoticePending after TurnFailed and before the notice is sent", () => {
    expect(stateAfter(turnFailed)).toEqual({ _tag: "FailedNoticePending" });
    expect(stateAfter(turnFailed, planned)).toEqual({
      _tag: "FailedNoticePending",
    });
  });

  it("is FailedNoticeSent after the notice is confirmed", () => {
    expect(stateAfter(turnFailed, planned, started, sent)).toEqual({
      _tag: "FailedNoticeSent",
      text: "planned text",
    });
  });

  it("is FailedNoticeRefused when the notice send fails, and SendFailureRecorded after a failed send of a reply", () => {
    expect(stateAfter(turnFailed, planned, started, refused)).toMatchObject({
      _tag: "FailedNoticeRefused",
    });
    expect(
      stateAfter(planned, started, refused, {
        ...turnFailed,
        reason: "refused",
      })
    ).toEqual({
      _tag: "SendFailureRecorded",
      text: "planned text",
      reason: "refused",
    });
  });

  it("follows the newest plan when a reaction plan and a text plan are both in the Journal", () => {
    const reaction: JournalRecord = {
      _tag: "ReactionPlanned",
      eventId,
      emoji: "✍",
    };

    expect(stateAfter(reaction, planned, started)).toEqual({
      _tag: "Unconfirmed",
      text: "planned text",
    });
    expect(stateAfter(reaction, planned, started, sent)).toEqual({
      _tag: "Sent",
      text: "planned text",
      reaction: undefined,
      channelMessageId: "9100",
    });
    expect(stateAfter(planned, reaction, started)).toEqual({
      _tag: "ReactionUnconfirmed",
      emoji: "✍",
    });
    expect(stateAfter(planned, reaction, started, sent)).toEqual({
      _tag: "Sent",
      text: undefined,
      reaction: "✍",
      channelMessageId: "9100",
    });
  });

  it("is Silent after StayedSilent, so recovery never sends for the Event", () => {
    expect(stateAfter({ _tag: "StayedSilent", eventId })).toEqual({
      _tag: "Silent",
    });
  });

  it("is FailedNoticeUnconfirmed after a reset that follows the start of the notice send", () => {
    expect(stateAfter(turnFailed, planned, started)).toEqual({
      _tag: "FailedNoticeUnconfirmed",
      text: "planned text",
    });
  });
});

type Answer = Delivery | "never";

const answer: { next: Answer } = {
  next: { _tag: "Confirmed", channelMessageId: "7000" },
};

const sentTexts: string[] = [];

const testChannel = Layer.succeed(Channel, {
  send: (message) => {
    sentTexts.push(message.text);
    return answer.next === "never" ? Effect.never : Effect.succeed(answer.next);
  },
  react: () =>
    answer.next === "never" ? Effect.never : Effect.succeed(answer.next),
  allowedReaction: (emoji) => emoji,
  showTyping: () => Effect.void,
});

const testServices = Layer.mergeAll(
  testChannel,
  Redactor.layer([]),
  OperatorMetrics.layer(fakeMetrics.dataset)
);

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    | Channel
    | Conversation
    | Inbox
    | Journal
    | OperatorMetrics
    | OwnerChannelConversation
    | Redactor
    | Schedules
    | TurnTraces
  >
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        effect.pipe(Effect.provide(testServices)) as Effect.Effect<A, E>
      )
  );

const storeOwnerMessage = Effect.gen(function* storeEffect() {
  const inbox = yield* Inbox;
  yield* inbox.store({
    _tag: "OwnerMessage",
    channel: "telegram",
    channelUpdateId: "delivery-1",
    conversationId: "55",
    channelMessageId: "71",
    text: "hello",
    sentAt: DateTime.formatIso(yield* DateTime.now),
  });
  const [event] = yield* inbox.pending;
  if (event === undefined) {
    return yield* Effect.die("The Inbox has no Event");
  }
  return event;
});

beforeEach(() => {
  resetFakes();
  sentTexts.length = 0;
  answer.next = { _tag: "Confirmed", channelMessageId: "7000" };
});

describe("Delivery through its interface", () => {
  it("sends once and reads Sent", async () => {
    const state = await inAgent(
      "delivery-sent",
      Effect.gen(function* scenario() {
        const event = yield* storeOwnerMessage;
        const result = yield* send(event, "the reply");
        return { result, state: yield* deliveryStateOf(event.eventId) };
      })
    );

    expect(state.result).toEqual({
      _tag: "Confirmed",
      channelMessageId: "7000",
    });
    expect(state.state).toEqual({
      _tag: "Sent",
      text: "the reply",
      channelMessageId: "7000",
    });
    expect(sentTexts).toEqual(["the reply"]);
  });

  it("reads SendFailed after a refused send, with the reason", async () => {
    answer.next = { _tag: "Failed", reason: "chat not found" };

    const state = await inAgent(
      "delivery-refused",
      Effect.gen(function* scenario() {
        const event = yield* storeOwnerMessage;
        yield* send(event, "the reply");
        return yield* deliveryStateOf(event.eventId);
      })
    );

    expect(state).toEqual({
      _tag: "SendFailed",
      text: "the reply",
      reason: "chat not found",
    });
  });

  it("reads Unconfirmed when the send never answers, and records the unconfirmed failure", async () => {
    answer.next = "never";

    const states = await inAgent(
      "delivery-unconfirmed",
      Effect.gen(function* scenario() {
        const event = yield* storeOwnerMessage;
        yield* send(event, "the reply").pipe(Effect.timeoutOption("20 millis"));
        const unconfirmed = yield* deliveryStateOf(event.eventId);
        yield* recordUnconfirmedSend(event);
        yield* fail(event, unconfirmedSendReason);
        return { unconfirmed, settled: yield* deliveryStateOf(event.eventId) };
      })
    );

    expect(states.unconfirmed).toEqual({
      _tag: "Unconfirmed",
      text: "the reply",
    });
    expect(states.settled).toMatchObject({
      _tag: "SendFailureRecorded",
      reason: unconfirmedSendReason,
    });
  });

  it("fails an Event with the honest notice and reads FailedNoticeSent", async () => {
    const state = await inAgent(
      "delivery-notice",
      Effect.gen(function* scenario() {
        const event = yield* storeOwnerMessage;
        yield* failWithNotice(event, "model down");
        return yield* deliveryStateOf(event.eventId);
      })
    );

    expect(state).toEqual({
      _tag: "FailedNoticeSent",
      text: honestFailureText,
    });
    expect(sentTexts).toEqual([honestFailureText]);
  });

  it("fails an Event with no notice and reads FailedNoticePending", async () => {
    const state = await inAgent(
      "delivery-no-notice",
      Effect.gen(function* scenario() {
        const event = yield* storeOwnerMessage;
        yield* fail(event, "send failed");
        return yield* deliveryStateOf(event.eventId);
      })
    );

    expect(state).toEqual({ _tag: "FailedNoticePending" });
    expect(sentTexts).toEqual([]);
  });

  it("reads SendFailed for a ScheduleFired Event when the Owner has no Channel conversation", async () => {
    const state = await inAgent(
      "delivery-no-conversation",
      Effect.gen(function* scenario() {
        const schedules = yield* Schedules;
        const inbox = yield* Inbox;
        const now = yield* DateTime.now;
        yield* schedules.set({
          action: { _tag: "SendText", text: "x" },
          setBy: "owner",
          dueAt: DateTime.subtract(now, { seconds: 5 }),
          sourceEventId: "seed",
        });
        yield* storeDueScheduleEvents;
        const [event] = yield* inbox.pending;
        if (event === undefined) {
          return yield* Effect.die("The Inbox has no Event");
        }
        yield* send(event, "text");
        return yield* deliveryStateOf(event.eventId);
      })
    );

    expect(state).toMatchObject({
      _tag: "SendFailed",
      reason: noOwnerConversationReason,
    });
  });

  it("records the outcome of an Event once, with one Trace and one metric", async () => {
    const outcomes = await inAgent(
      "delivery-outcome",
      Effect.gen(function* scenario() {
        const traces = yield* TurnTraces;
        const record = recordOutcome({
          trace: {
            eventId,
            task: "reminder_delivery",
            result: "reminder_delivered",
            scheduleId: "schedule-1",
            dueAt: "2026-01-01T00:00:00.000Z",
            late: false,
            text: "x",
            channelMessageId: "1",
            error: null,
            latencyMillis: 0,
          },
          metric: {
            kind: "reminder",
            ownerId: OwnerIdSchema.make("delivery-outcome"),
            eventId,
            result: "delivered",
            latencyMillis: 0,
          },
        });
        yield* record;
        yield* record;
        return yield* traces.readForEvent(eventId);
      })
    );

    expect(outcomes).toHaveLength(1);
    expect(fakeMetrics.dataPoints).toHaveLength(1);
  });
});

const seedFiredScheduledTask = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  const agent = await personalAgentFor(
    env.PERSONAL_AGENT,
    OwnerIdSchema.make(ownerId)
  );
  const seeded = await runInDurableObject(agent, (instance) =>
    instance.runtime.runPromise(
      Effect.gen(function* seedEffect() {
        const schedules = yield* Schedules;
        const inbox = yield* Inbox;
        const conversation = yield* OwnerChannelConversation;
        yield* conversation.remember({
          _tag: "OwnerMessage",
          channel: "telegram",
          channelUpdateId: "seed-owner-message",
          conversationId: String(telegramUserId),
          channelMessageId: "1",
          text: "hi",
          sentAt: DateTime.formatIso(yield* DateTime.now),
        });
        const now = yield* DateTime.now;
        yield* schedules.set({
          action: { _tag: "RunPrompt", prompt: "List my tasks" },
          setBy: "owner",
          dueAt: DateTime.subtract(now, { seconds: 5 }),
          sourceEventId: "seed",
        });
        yield* storeDueScheduleEvents;
        const [event] = yield* inbox.pending;
        return event;
      })
    )
  );
  return { ownerId, agent, eventId: seeded?.eventId ?? "" };
};

const traceTasksOf = (ownerId: string) =>
  inAgent(
    ownerId,
    TurnTraces.pipe(
      Effect.flatMap((traces) => traces.read),
      Effect.map((stored) => stored.map(({ trace }) => trace.task))
    )
  );

describe("a Scheduled Task Event after a reset", () => {
  it("keeps its one scheduled_task Trace when the reset comes after a confirmed send", async () => {
    const {
      ownerId,
      agent,
      eventId: firedEventId,
    } = await seedFiredScheduledTask(9801);
    await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const journal = yield* Journal;
          const traces = yield* TurnTraces;
          yield* traces.record({
            eventId: firedEventId,
            task: "scheduled_task_skip",
            result: "scheduled_task_skipped",
            scheduleId: "schedule",
            dueAt: "2026-01-01T00:00:00.000Z",
            dailyTokenBudget: 1,
            tokensSpent: 1,
            text: "skipped",
          });
          yield* journal.append({
            _tag: "ReplyPlanned",
            eventId: firedEventId,
            text: "result",
          });
          yield* journal.append({ _tag: "SendStarted", eventId: firedEventId });
          yield* journal.append({
            _tag: "ReplySent",
            eventId: firedEventId,
            channelMessageId: "9000",
          });
        })
      )
    );
    await abortAllDurableObjects();

    await runInDurableObject(
      await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
      (instance) => instance.runTurn()
    );

    expect(await traceTasksOf(ownerId)).toEqual(["scheduled_task_skip"]);
  });

  it("gets no reminder_delivery Trace when the reset comes after the start of a failure notice", async () => {
    const {
      ownerId,
      agent,
      eventId: firedEventId,
    } = await seedFiredScheduledTask(9803);
    await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const journal = yield* Journal;
          yield* journal.append({
            _tag: "TurnFailed",
            eventId: firedEventId,
            reason: "step limit",
          });
          yield* journal.append({
            _tag: "ReplyPlanned",
            eventId: firedEventId,
            text: "notice",
          });
          yield* journal.append({ _tag: "SendStarted", eventId: firedEventId });
        })
      )
    );
    await abortAllDurableObjects();

    await runInDurableObject(
      await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
      (instance) => instance.runTurn()
    );

    expect(await traceTasksOf(ownerId)).toEqual([]);
    expect(fakeTelegram.sent).toHaveLength(0);
  });

  it("gets a scheduled_task Trace when the reset comes after ReplyPlanned", async () => {
    const {
      ownerId,
      agent,
      eventId: firedEventId,
    } = await seedFiredScheduledTask(9802);
    await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Journal.pipe(
          Effect.flatMap((journal) =>
            journal.append({
              _tag: "ReplyPlanned",
              eventId: firedEventId,
              text: "result",
            })
          )
        )
      )
    );
    await abortAllDurableObjects();

    await runInDurableObject(
      await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
      (instance) => instance.runTurn()
    );

    await vi.waitFor(async () =>
      expect(await traceTasksOf(ownerId)).toEqual(["scheduled_task"])
    );
    expect(fakeTelegram.sent).toHaveLength(1);
  });
});
