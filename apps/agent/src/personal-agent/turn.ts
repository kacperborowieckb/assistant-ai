import type { ModelMessage } from "ai";
import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { OwnerId } from "../owner-id.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import {
  modelFailureReason,
  responseMessagesOf,
  recordTurnMetric,
  traceOf,
} from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";

export const systemPrompt = (behavior: BehaviorConfig) =>
  [
    "You are the Owner's Personal Agent. You talk with the Owner in a chat.",
    "Answer the Owner's newest messages. Be honest when you do not know something.",
    behavior.textingStyle,
  ].join("\n");

const ownerMessage = (event: InboxEvent): ModelMessage => ({
  role: "user",
  content: event.text,
});

export const honestFailureText =
  "Sorry, I could not answer that. Please try again in a moment.";

const deliver = (event: InboxEvent, text: string) =>
  Effect.gen(function* deliverEffect() {
    const journal = yield* Journal;
    const channel = yield* Channel;
    const redactor = yield* Redactor;

    yield* journal.append({
      _tag: "ReplyPlanned",
      eventId: event.eventId,
      text,
    });
    yield* journal.append({ _tag: "SendStarted", eventId: event.eventId });
    const delivery = yield* channel.send({
      conversationId: event.conversationId,
      inReplyTo: event.channelMessageId,
      text,
    });

    if (delivery._tag === "Failed") {
      const reason = redactor.redact(delivery.reason);
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason,
      });
      return { _tag: "Failed", reason } as const;
    }
    yield* journal.append({
      _tag: "ReplySent",
      eventId: event.eventId,
      channelMessageId: delivery.channelMessageId,
    });
    return delivery;
  });

const recordTurnFailed = (event: InboxEvent, reason: string) =>
  Effect.gen(function* recordTurnFailedEffect() {
    const inbox = yield* Inbox;
    const journal = yield* Journal;

    yield* journal.append({
      _tag: "TurnFailed",
      eventId: event.eventId,
      reason,
    });
    yield* inbox.markFailed([event]);
  });

const sendHonestFailure = (event: InboxEvent) =>
  Effect.gen(function* sendHonestFailureEffect() {
    const inbox = yield* Inbox;

    yield* deliver(event, honestFailureText);
    yield* inbox.markFailed([event]);
  });

const failTurnWithHonestMessage = (event: InboxEvent, reason: string) =>
  Effect.gen(function* failTurnWithHonestMessageEffect() {
    const journal = yield* Journal;

    yield* journal.append({
      _tag: "TurnFailed",
      eventId: event.eventId,
      reason,
    });
    yield* sendHonestFailure(event);
  });

const rememberCompletedSteps = (event: InboxEvent, outcome: ModelOutcome) =>
  Effect.gen(function* rememberCompletedStepsEffect() {
    const conversation = yield* Conversation;
    const redactor = yield* Redactor;
    const completed = responseMessagesOf(outcome);

    if (completed.length > 0) {
      yield* conversation.append([
        ownerMessage(event),
        ...completed.map((message) => redactor.redactMessage(message)),
      ]);
    }
  });

interface TurnSettings {
  readonly behavior: BehaviorConfig;
  readonly tools: AgentTools;
}

const answer = (
  ownerId: OwnerId,
  { behavior, tools }: TurnSettings,
  event: InboxEvent
) =>
  Effect.gen(function* answerEffect() {
    const inbox = yield* Inbox;
    const conversation = yield* Conversation;
    const modelGateway = yield* ModelGateway;
    const traces = yield* TurnTraces;
    const redactor = yield* Redactor;

    const startedAt = yield* Clock.currentTimeMillis;
    const history = yield* conversation.recent;
    const system = systemPrompt(behavior);
    const messages = [...history, ownerMessage(event)];
    const outcome: ModelOutcome = yield* modelGateway
      .generate({
        task: "reply",
        system,
        messages,
        tools,
        stepLimit: behavior.maxToolSteps,
      })
      .pipe(
        Effect.map((reply): ModelOutcome => ({ _tag: "Replied", reply })),
        Effect.catchTags({
          ModelUnavailable: (error) =>
            Effect.succeed<ModelOutcome>({ _tag: "ModelFailed", error }),
          StepLimitReached: (error) =>
            Effect.succeed<ModelOutcome>({ _tag: "ModelFailed", error }),
        })
      );
    const modelLatencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
    yield* traces.record(
      traceOf({
        event,
        system,
        messages,
        outcome,
        modelLatencyMillis,
        redactor,
      })
    );

    if (outcome._tag === "ModelFailed") {
      yield* rememberCompletedSteps(event, outcome);
      yield* failTurnWithHonestMessage(
        event,
        modelFailureReason(outcome.error, redactor)
      );
      yield* recordTurnMetric({
        ownerId,
        outcome,
        result: "model_failed",
        startedAt,
      });
      return;
    }
    const replyText = redactor.redact(outcome.reply.text);
    const delivery = yield* deliver(event, replyText);
    if (delivery._tag === "Failed") {
      yield* recordTurnFailed(event, delivery.reason);
      yield* recordTurnMetric({
        ownerId,
        outcome,
        result: "send_failed",
        startedAt,
      });
      return;
    }
    yield* conversation.append([
      ownerMessage(event),
      ...responseMessagesOf(outcome).map((message) =>
        redactor.redactMessage(message)
      ),
    ]);
    yield* inbox.markDone([event]);
    yield* recordTurnMetric({ ownerId, outcome, result: "replied", startedAt });
  });

export const unconfirmedSendReason =
  "A send started but Telegram did not confirm it, so the agent did not send again";

const settleFromJournal = (event: InboxEvent) =>
  Effect.gen(function* settleFromJournalEffect() {
    const inbox = yield* Inbox;
    const journal = yield* Journal;
    const entries = yield* journal.readForEvent(event.eventId);
    const tags = new Set(entries.map((entry) => entry.record._tag));

    if (tags.has("TurnFailed")) {
      if (!tags.has("SendStarted")) {
        yield* sendHonestFailure(event);
        return "settled" as const;
      }
      if (!tags.has("ReplySent") && !tags.has("ReplyFailed")) {
        yield* journal.append({
          _tag: "ReplyFailed",
          eventId: event.eventId,
          reason: unconfirmedSendReason,
        });
      }
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    if (tags.has("ReplySent")) {
      yield* inbox.markDone([event]);
      return "settled" as const;
    }
    const failedSend = entries.find(
      (entry) => entry.record._tag === "ReplyFailed"
    );
    if (failedSend?.record._tag === "ReplyFailed") {
      yield* recordTurnFailed(event, failedSend.record.reason);
      return "settled" as const;
    }
    if (tags.has("SendStarted")) {
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason: unconfirmedSendReason,
      });
      yield* recordTurnFailed(event, unconfirmedSendReason);
      return "settled" as const;
    }
    return "unanswered" as const;
  });

export const takeTurn = (
  ownerId: OwnerId,
  behavior: BehaviorConfig,
  tools: AgentTools = noTools
) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const events = yield* inbox.pending;
    for (const event of events) {
      const outcome = yield* settleFromJournal(event);
      if (outcome === "unanswered") {
        yield* answer(ownerId, { behavior, tools }, event);
      }
    }
  });
