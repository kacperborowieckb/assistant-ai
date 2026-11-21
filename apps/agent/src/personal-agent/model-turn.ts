import type { ModelMessage } from "ai";
import { Clock, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { OwnerId } from "../owner-id.ts";
import { Profile } from "../profile/profile.ts";
import { ownerCurrentTimeText } from "../time/owner-current-time.ts";
import type { TurnMetricResult } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import type { TurnTrace } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { Conversation } from "./conversation.ts";
import { react } from "./delivery-reaction.ts";
import { fail, send, staySilent } from "./delivery.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { generateWithOutcomeTools } from "./outcome-tools.ts";
import { rememberCompletedSteps } from "./remember-completed-steps.ts";
import type { OutcomeKind } from "./storage-values.ts";
import { systemPrompt } from "./system-prompt.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  recordTurnMetric,
  responseMessagesOf,
  stepLimitReason,
} from "./turn-record.ts";
import type { ModelTraceInput } from "./turn-record.ts";
import { recordSuperseded, restartCountForTurn } from "./turn-restart.ts";
import type { Restart } from "./turn-restart.ts";

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
  readonly replyTo?: InboxEvent;
  readonly inputs: readonly ModelMessage[];
  readonly tools: AgentTools;
  readonly traceOf: (model: ModelTraceInput) => TurnTrace;
  readonly restartSection?: string;
  readonly restartBeforeDelivery?: (
    restartsDone: number
  ) => Effect.Effect<Option.Option<Restart>, Failure, Requirements>;
  readonly checkBeforeFirstStep?: (
    startedAt: number
  ) => Effect.Effect<BeforeFirstStep, Failure, Requirements>;
  readonly prepare?: Effect.Effect<TurnPreparation, Failure, Requirements>;
  readonly tracesSendFailure?: boolean;
  readonly whenSent?: Effect.Effect<void, Failure, Requirements>;
  readonly whenSilent?: Effect.Effect<void, Failure, Requirements>;
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
    const { database } = yield* AgentStorage;
    const inbox = yield* Inbox;
    const conversation = yield* Conversation;
    const traces = yield* TurnTraces;
    const redactor = yield* Redactor;
    const profile = yield* Profile;
    const progress = yield* TurnProgress;

    const startedAt = yield* Clock.currentTimeMillis;
    const restartsDone = yield* restartCountForTurn(event.eventId);
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
      situation: [
        ...(restartsDone > 0 && kind.restartSection !== undefined
          ? [kind.restartSection]
          : []),
        ...preparation.situation,
      ],
    });
    const savedInputs = kind.inputs.map((input) =>
      redactor.redactMessage(input)
    );
    const earlier = yield* progress.completedFor(event.eventId);
    const stepsLeft = behavior.maxToolSteps - stepsUsed;
    if (stepsLeft <= 0) {
      yield* conversation.append(event.eventId, [...savedInputs, ...earlier]);
      yield* kind.whenFailed(stepLimitReason(behavior.maxToolSteps));
      return;
    }
    const messages = [...history, ...kind.inputs, ...earlier];
    const decided = yield* generateWithOutcomeTools({
      eventId: event.eventId,
      earlierMessages: earlier,
      request: {
        task: kind.task,
        system,
        messages,
        tools: kind.tools,
        stepLimit: stepsLeft,
      },
      tools: kind.tools,
      defaultReaction: behavior.defaultReaction,
    });
    const { outcome } = decided;
    const modelLatencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
    const traceInput = {
      system,
      messages,
      outcome,
      modelLatencyMillis,
      redactor,
      outcomeKind: decided.kind,
      reaction: decided.reaction,
      refusedOutcomeTools: decided.refusedOutcomeTools,
    };
    const recordTrace = (delivered: boolean) =>
      traces.record(kind.traceOf({ ...traceInput, delivered }));
    const recordMetric = (
      result: TurnMetricResult,
      outcomeKind?: OutcomeKind,
      restartCount = restartsDone
    ) =>
      recordTurnMetric({
        ownerId,
        eventId: event.eventId,
        outcome,
        result,
        outcomeKind,
        startedAt,
        restartCount,
      });
    const restart =
      kind.restartBeforeDelivery === undefined
        ? Option.none<Restart>()
        : yield* kind.restartBeforeDelivery(restartsDone);
    if (Option.isSome(restart)) {
      const { coveredEventIds, newEventIds } = restart.value;
      yield* recordSuperseded(
        restart.value,
        kind.traceOf({
          ...traceInput,
          delivered: false,
          restart: { coveredEventIds, newEventIds },
        }),
        event.eventId
      );
      yield* recordMetric("superseded", undefined, restart.value.restartCount);
      return "Superseded" as const;
    }
    yield* recordTrace(true);

    const remember = rememberCompletedSteps({
      eventId: event.eventId,
      inputs: savedInputs,
      earlier,
      outcome,
    });
    if (outcome._tag === "ModelFailed") {
      yield* remember;
      yield* kind.whenFailed(modelFailureReason(outcome.error, redactor));
      yield* recordMetric("model_failed");
      return;
    }
    if (decided.kind === "silent") {
      yield* database.transaction(() =>
        conversation
          .append(event.eventId, [
            ...savedInputs,
            ...earlier,
            ...responseMessagesOf(outcome).map((message) =>
              redactor.redactMessage(message)
            ),
          ])
          .pipe(
            Effect.andThen(staySilent(event)),
            Effect.andThen(inbox.markDone([event])),
            Effect.andThen(kind.whenSilent ?? Effect.void)
          )
      );
      yield* recordMetric("silent", "silent");
      return;
    }
    const outcomeKind = decided.reaction === undefined ? "reply" : "reaction";
    const delivery =
      decided.reaction === undefined
        ? yield* send(
            event,
            preparation.lateText(redactor.redact(outcome.reply.text)),
            kind.replyTo
          )
        : yield* react(event, decided.reaction.emoji, kind.replyTo);
    if (delivery._tag === "Failed") {
      yield* remember;
      if (kind.tracesSendFailure === true) {
        yield* recordTrace(false);
      }
      if (kind.whenSendFailed !== undefined) {
        yield* kind.whenSendFailed;
      }
      yield* fail(event, delivery.reason);
      yield* recordMetric("send_failed", outcomeKind);
      return;
    }
    if (kind.whenSent !== undefined) {
      yield* kind.whenSent;
    }
    yield* conversation.append(event.eventId, [
      ...savedInputs,
      ...earlier,
      ...responseMessagesOf(outcome).map((message) =>
        redactor.redactMessage(message)
      ),
    ]);
    yield* inbox.markDone([event]);
    yield* recordMetric(
      outcomeKind === "reply" ? "replied" : "reacted",
      outcomeKind
    );
  });
