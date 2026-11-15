import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import {
  ModelGateway,
  attemptTimeoutMillis,
  modelAttempts,
} from "../model-gateway/model-gateway.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import type { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import type { OwnerId } from "../owner-id.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import type { PromptMessage, TurnTrace } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import type { ConversationMessage } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";

export const systemPrompt = (behavior: BehaviorConfig) =>
  [
    "You are the Owner's Personal Agent. You talk with the Owner in a chat.",
    "Answer the Owner's newest messages. Be honest when you do not know something.",
    behavior.textingStyle,
  ].join("\n");

const toPromptMessage = (message: ConversationMessage): PromptMessage =>
  message.role === "owner"
    ? { role: "user", content: message.text }
    : { role: "assistant", content: message.text };

const ownerMessage = (event: InboxEvent): ConversationMessage => ({
  role: "owner",
  text: event.text,
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

const modelFailureReason = (
  error: ModelUnavailable,
  redactor: Redactor["Service"]
) =>
  redactor.redact(
    `The model failed ${modelAttempts} times: ${String(error.cause)}`
  );

type ModelOutcome =
  | { readonly _tag: "Replied"; readonly reply: ModelReply }
  | { readonly _tag: "ModelFailed"; readonly error: ModelUnavailable };

const traceOf = (
  event: InboxEvent,
  system: string,
  messages: readonly PromptMessage[],
  outcome: ModelOutcome,
  modelLatencyMillis: number,
  redactor: Redactor["Service"]
): TurnTrace => {
  const base = {
    eventId: event.eventId,
    task: "reply",
    modelSettings: { attempts: modelAttempts, attemptTimeoutMillis },
    system,
    messages,
    toolCalls: [],
    modelLatencyMillis,
  } as const;
  if (outcome._tag === "Replied") {
    return {
      ...base,
      result: "replied",
      modelId: outcome.reply.modelId,
      reply: outcome.reply.text,
      error: null,
      usage: {
        inputTokens: outcome.reply.usage.inputTokens ?? null,
        outputTokens: outcome.reply.usage.outputTokens ?? null,
        cachedInputTokens: outcome.reply.usage.cachedInputTokens ?? null,
        costUsd: outcome.reply.usage.costUsd ?? null,
      },
    };
  }
  return {
    ...base,
    result: "model_failed",
    modelId: outcome.error.modelId,
    reply: null,
    error: modelFailureReason(outcome.error, redactor),
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
    },
  };
};

const recordTurnMetric = (
  ownerId: OwnerId,
  outcome: ModelOutcome,
  result: Extract<OperatorMetric, { kind: "turn" }>["result"],
  startedAt: number
) =>
  Effect.gen(function* recordTurnMetricEffect() {
    const metrics = yield* OperatorMetrics;
    const now = yield* Clock.currentTimeMillis;
    yield* metrics.record({
      kind: "turn",
      ownerId,
      result,
      latencyMillis: now - startedAt,
      modelId:
        outcome._tag === "Replied"
          ? outcome.reply.modelId
          : outcome.error.modelId,
      usage: outcome._tag === "Replied" ? outcome.reply.usage : undefined,
    });
  });

const answer = (
  ownerId: OwnerId,
  behavior: BehaviorConfig,
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
    const messages = [...history, ownerMessage(event)].map(toPromptMessage);
    const outcome: ModelOutcome = yield* modelGateway
      .generate({ task: "reply", system, messages })
      .pipe(
        Effect.map((reply): ModelOutcome => ({ _tag: "Replied", reply })),
        Effect.catchTag("ModelUnavailable", (error) =>
          Effect.succeed<ModelOutcome>({ _tag: "ModelFailed", error })
        )
      );
    const modelLatencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
    yield* traces.record(
      traceOf(event, system, messages, outcome, modelLatencyMillis, redactor)
    );

    if (outcome._tag === "ModelFailed") {
      yield* failTurnWithHonestMessage(
        event,
        modelFailureReason(outcome.error, redactor)
      );
      yield* recordTurnMetric(ownerId, outcome, "model_failed", startedAt);
      return;
    }
    const delivery = yield* deliver(event, outcome.reply.text);
    if (delivery._tag === "Failed") {
      yield* recordTurnFailed(event, delivery.reason);
      yield* recordTurnMetric(ownerId, outcome, "send_failed", startedAt);
      return;
    }
    yield* conversation.append([
      ownerMessage(event),
      { role: "agent", text: outcome.reply.text },
    ]);
    yield* inbox.markDone([event]);
    yield* recordTurnMetric(ownerId, outcome, "replied", startedAt);
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

export const takeTurn = (ownerId: OwnerId, behavior: BehaviorConfig) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const events = yield* inbox.pending;
    for (const event of events) {
      const outcome = yield* settleFromJournal(event);
      if (outcome === "unanswered") {
        yield* answer(ownerId, behavior, event);
      }
    }
  });
