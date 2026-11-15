import type { ModelMessage } from "ai";
import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { noteToolsFor } from "../notes/capture-note-tool.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { systemPrompt } from "./system-prompt.ts";
import {
  deliver,
  failTurnWithHonestMessage,
  recordTurnFailed,
  sendHonestFailure,
} from "./turn-delivery.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  responseMessagesOf,
  toolMessagesOf,
  recordTurnMetric,
  traceOf,
} from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";

const ownerMessage = (event: InboxEvent): ModelMessage => ({
  role: "user",
  content: event.text,
});

const rememberCompletedSteps = (
  event: InboxEvent,
  earlier: readonly ModelMessage[],
  outcome: ModelOutcome
) =>
  Effect.gen(function* rememberCompletedStepsEffect() {
    const conversation = yield* Conversation;
    const redactor = yield* Redactor;
    const completed = toolMessagesOf(outcome);

    if (completed.length > 0) {
      yield* conversation.append([
        ownerMessage(event),
        ...earlier,
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
    const notes = yield* Notes;
    const progress = yield* TurnProgress;

    const startedAt = yield* Clock.currentTimeMillis;
    const history = yield* conversation.recent;
    const system = systemPrompt(behavior);
    const earlier = yield* progress.completedFor(event.eventId);
    const messages = [...history, ownerMessage(event), ...earlier];
    const outcome: ModelOutcome = yield* modelGateway
      .generate({
        task: "reply",
        system,
        messages,
        tools: { ...tools, ...noteToolsFor(notes, event) },
        stepLimit: behavior.maxToolSteps,
        onToolStepFinished: (step) =>
          progress.recordToolStep(
            event.eventId,
            step.responseMessages.map((message) =>
              redactor.redactMessage(message)
            )
          ),
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
      yield* rememberCompletedSteps(event, earlier, outcome);
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
      yield* rememberCompletedSteps(event, earlier, outcome);
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
      ...earlier,
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
