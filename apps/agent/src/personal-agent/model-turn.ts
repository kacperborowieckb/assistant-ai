import type { ModelMessage } from "ai";
import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { OwnerId } from "../owner-id.ts";
import { Profile } from "../profile/profile.ts";
import { ownerCurrentTimeText } from "../time/owner-current-time.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import type { TurnTrace } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { fail, send, staySilent } from "./delivery.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { generateWithOutcomeTools } from "./outcome-tools.ts";
import { rememberCompletedSteps } from "./remember-completed-steps.ts";
import { systemPrompt } from "./system-prompt.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  recordTurnMetric,
  responseMessagesOf,
  stepLimitReason,
} from "./turn-record.ts";
import type { ModelTraceInput } from "./turn-record.ts";

export type BeforeFirstStep = "Proceed" | "Stopped";

export interface TurnPreparation {
  readonly situation: readonly string[];
  readonly lateText: (text: string) => string;
}

const unpreparedTurn: TurnPreparation = {
  situation: [],
  lateText: (text) => text,
};

export interface ModelTurnKind<Failure, Requirements> {
  readonly task: "reply" | "scheduled_task" | "proactive";
  readonly event: InboxEvent;
  readonly input: ModelMessage;
  readonly tools: AgentTools;
  readonly traceOf: (model: ModelTraceInput) => TurnTrace;
  readonly checkBeforeFirstStep?: (
    startedAt: number
  ) => Effect.Effect<BeforeFirstStep, Failure, Requirements>;
  readonly prepare?: Effect.Effect<TurnPreparation, Failure, Requirements>;
  readonly tracesSendFailure?: boolean;
  readonly whenSent?: Effect.Effect<void, Failure, Requirements>;
  readonly whenSendFailed?: Effect.Effect<void, Failure, Requirements>;
  readonly whenFailed: (
    reason: string
  ) => Effect.Effect<void, Failure, Requirements>;
}

interface ModelTurn<Failure, Requirements> {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly kind: ModelTurnKind<Failure, Requirements>;
}

export const runModelTurn = <Failure, Requirements>({
  ownerId,
  behavior,
  kind,
}: ModelTurn<Failure, Requirements>) =>
  Effect.gen(function* runModelTurnEffect() {
    const { event } = kind;
    const inbox = yield* Inbox;
    const conversation = yield* Conversation;
    const traces = yield* TurnTraces;
    const redactor = yield* Redactor;
    const profile = yield* Profile;
    const progress = yield* TurnProgress;

    const startedAt = yield* Clock.currentTimeMillis;
    const stepsUsed = yield* progress.usedStepCount(event.eventId);
    if (stepsUsed === 0 && kind.checkBeforeFirstStep !== undefined) {
      const check = yield* kind.checkBeforeFirstStep(startedAt);
      if (check === "Stopped") {
        return;
      }
    }
    const preparation =
      kind.prepare === undefined ? unpreparedTurn : yield* kind.prepare;
    const history = yield* conversation.recent;
    const system = systemPrompt({
      behavior,
      profile: yield* profile.read,
      currentTime: yield* ownerCurrentTimeText(behavior),
      situation: preparation.situation,
    });
    const savedInput = redactor.redactMessage(kind.input);
    const earlier = yield* progress.completedFor(event.eventId);
    const stepsLeft = behavior.maxToolSteps - stepsUsed;
    if (stepsLeft <= 0) {
      yield* conversation.append(event.eventId, [savedInput, ...earlier]);
      yield* kind.whenFailed(stepLimitReason(behavior.maxToolSteps));
      return;
    }
    const messages = [...history, kind.input, ...earlier];
    const decided = yield* generateWithOutcomeTools({
      eventId: event.eventId,
      request: {
        task: kind.task,
        system,
        messages,
        tools: kind.tools,
        stepLimit: stepsLeft,
      },
      tools: kind.tools,
    });
    const { outcome } = decided;
    const modelLatencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
    const recordTrace = (delivered: boolean) =>
      traces.record(
        kind.traceOf({
          system,
          messages,
          outcome,
          modelLatencyMillis,
          redactor,
          delivered,
          outcomeKind: decided.kind,
          refusedOutcomeTools: decided.refusedOutcomeTools,
        })
      );
    yield* recordTrace(true);

    const remember = rememberCompletedSteps({
      eventId: event.eventId,
      input: savedInput,
      earlier,
      outcome,
    });
    if (outcome._tag === "ModelFailed") {
      yield* remember;
      yield* kind.whenFailed(modelFailureReason(outcome.error, redactor));
      yield* recordTurnMetric({
        ownerId,
        eventId: event.eventId,
        outcome,
        result: "model_failed",
        startedAt,
      });
      return;
    }
    if (decided.kind === "silent") {
      yield* staySilent(event);
      yield* conversation.append(event.eventId, [
        savedInput,
        ...earlier,
        ...responseMessagesOf(outcome).map((message) =>
          redactor.redactMessage(message)
        ),
      ]);
      yield* inbox.markDone([event]);
      yield* recordTurnMetric({
        ownerId,
        eventId: event.eventId,
        outcome,
        result: "silent",
        outcomeKind: "silent",
        startedAt,
      });
      return;
    }
    const replyText = redactor.redact(outcome.reply.text);
    const delivery = yield* send(event, preparation.lateText(replyText));
    if (delivery._tag === "Failed") {
      yield* remember;
      if (kind.tracesSendFailure === true) {
        yield* recordTrace(false);
      }
      if (kind.whenSendFailed !== undefined) {
        yield* kind.whenSendFailed;
      }
      yield* fail(event, delivery.reason);
      yield* recordTurnMetric({
        ownerId,
        eventId: event.eventId,
        outcome,
        result: "send_failed",
        startedAt,
      });
      return;
    }
    if (kind.whenSent !== undefined) {
      yield* kind.whenSent;
    }
    yield* conversation.append(event.eventId, [
      savedInput,
      ...earlier,
      ...responseMessagesOf(outcome).map((message) =>
        redactor.redactMessage(message)
      ),
    ]);
    yield* inbox.markDone([event]);
    yield* recordTurnMetric({
      ownerId,
      eventId: event.eventId,
      outcome,
      result: "replied",
      outcomeKind: "reply",
      startedAt,
    });
  });
