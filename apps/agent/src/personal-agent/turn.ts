import type { ModelMessage } from "ai";
import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { noteToolsFor } from "../notes/note-tools.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { ownerMessage } from "./owner-message.ts";
import { systemPrompt } from "./system-prompt.ts";
import {
  deliver,
  failTurnWithHonestMessage,
  recordTurnFailed,
} from "./turn-delivery.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  stepLimitReason,
  responseMessagesOf,
  toolMessagesOf,
  recordTurnMetric,
  traceOf,
} from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";
import { settleFromJournal } from "./turn-recovery.ts";

const rememberCompletedSteps = (
  event: InboxEvent,
  earlier: readonly ModelMessage[],
  outcome: ModelOutcome
) =>
  Effect.gen(function* rememberCompletedStepsEffect() {
    const conversation = yield* Conversation;
    const redactor = yield* Redactor;
    const completed = toolMessagesOf(outcome);

    if (earlier.length + completed.length > 0) {
      yield* conversation.append(event.eventId, [
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
    const stepsLeft =
      behavior.maxToolSteps - (yield* progress.usedStepCount(event.eventId));
    if (stepsLeft <= 0) {
      yield* conversation.append(event.eventId, [
        ownerMessage(event),
        ...earlier,
      ]);
      yield* failTurnWithHonestMessage(
        event,
        stepLimitReason(behavior.maxToolSteps)
      );
      return;
    }
    const messages = [...history, ownerMessage(event), ...earlier];
    const outcome: ModelOutcome = yield* modelGateway
      .generate({
        task: "reply",
        system,
        messages,
        tools: {
          ...tools,
          ...noteToolsFor({ notes, progress, redactor }, event),
        },
        stepLimit: stepsLeft,
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
    yield* conversation.append(event.eventId, [
      ownerMessage(event),
      ...earlier,
      ...responseMessagesOf(outcome).map((message) =>
        redactor.redactMessage(message)
      ),
    ]);
    yield* inbox.markDone([event]);
    yield* recordTurnMetric({ ownerId, outcome, result: "replied", startedAt });
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
