import type { ModelMessage } from "ai";
import { Clock, Effect } from "effect";

import {
  attemptTimeoutMillis,
  modelAttempts,
} from "../model-gateway/model-gateway.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import type { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import type { StepLimitReached } from "../model-gateway/step-limit-reached.ts";
import { sumUsage } from "../model-gateway/usage-ledger.ts";
import type { Usage } from "../model-gateway/usage-ledger.ts";
import type { OwnerId } from "../owner-id.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { TurnTrace } from "../tracing/turn-trace.ts";
import type { InboxEvent } from "./inbox.ts";

export type ModelFailure = ModelUnavailable | StepLimitReached;

export const modelFailureReason = (
  error: ModelFailure,
  redactor: Redactor["Service"]
) =>
  redactor.redact(
    error._tag === "StepLimitReached"
      ? `The model did not give a final answer in ${error.stepLimit} steps`
      : `The model failed ${modelAttempts} times: ${String(error.cause)}`
  );

export type ModelOutcome =
  | { readonly _tag: "Replied"; readonly reply: ModelReply }
  | { readonly _tag: "ModelFailed"; readonly error: ModelFailure };

export const stepsOf = (outcome: ModelOutcome): readonly ModelStep[] =>
  outcome._tag === "Replied" ? outcome.reply.steps : outcome.error.steps;

const unknownUsage: Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  cachedInputTokens: undefined,
  costUsd: undefined,
};

const usageOfOutcome = (outcome: ModelOutcome): Usage | undefined => {
  if (outcome._tag === "Replied") {
    return outcome.reply.usage;
  }
  return outcome.error.steps.length === 0
    ? undefined
    : sumUsage(outcome.error.steps.map((step) => step.usage));
};

const traceUsageOf = (usage: Usage): TurnTrace["usage"] => ({
  inputTokens: usage.inputTokens ?? null,
  outputTokens: usage.outputTokens ?? null,
  cachedInputTokens: usage.cachedInputTokens ?? null,
  costUsd: usage.costUsd ?? null,
});

const traceStepsOf = (
  outcome: ModelOutcome,
  redactor: Redactor["Service"]
): TurnTrace["steps"] =>
  stepsOf(outcome).map((step) => ({
    toolCalls: step.toolCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      input: redactor.redact(call.input),
      output: redactor.redact(call.output),
      failed: call.failed,
    })),
    usage: traceUsageOf(step.usage),
  }));

interface TraceInput {
  readonly event: InboxEvent;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly outcome: ModelOutcome;
  readonly modelLatencyMillis: number;
  readonly redactor: Redactor["Service"];
}

export const traceOf = ({
  event,
  system,
  messages,
  outcome,
  modelLatencyMillis,
  redactor,
}: TraceInput): TurnTrace => {
  const reasoningEffort =
    outcome._tag === "Replied"
      ? outcome.reply.reasoningEffort
      : outcome.error.reasoningEffort;
  const base = {
    eventId: event.eventId,
    task: "reply",
    modelSettings: {
      attempts: modelAttempts,
      attemptTimeoutMillis,
      reasoningEffort,
    },
    system: redactor.redact(system),
    messages: messages.map((message) => redactor.redactMessage(message)),
    steps: traceStepsOf(outcome, redactor),
    modelLatencyMillis,
  } as const;
  if (outcome._tag === "Replied") {
    return {
      ...base,
      result: "model_replied",
      modelId: outcome.reply.modelId,
      reply: redactor.redact(outcome.reply.text),
      error: null,
      usage: traceUsageOf(outcome.reply.usage),
    };
  }
  return {
    ...base,
    result: "model_failed",
    modelId: outcome.error.modelId,
    reply: null,
    error: modelFailureReason(outcome.error, redactor),
    usage: traceUsageOf(usageOfOutcome(outcome) ?? unknownUsage),
  };
};

interface TurnMetricInput {
  readonly ownerId: OwnerId;
  readonly outcome: ModelOutcome;
  readonly result: Extract<OperatorMetric, { kind: "turn" }>["result"];
  readonly startedAt: number;
}

export const recordTurnMetric = ({
  ownerId,
  outcome,
  result,
  startedAt,
}: TurnMetricInput) =>
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
      usage: usageOfOutcome(outcome),
      stepCount: stepsOf(outcome).length,
      toolCallCount: stepsOf(outcome).flatMap((step) => step.toolCalls).length,
    });
  });

export const responseMessagesOf = (outcome: ModelOutcome) =>
  stepsOf(outcome).flatMap((step) => step.responseMessages);

export const toolMessagesOf = (outcome: ModelOutcome) =>
  (outcome._tag === "Replied"
    ? outcome.reply.steps.slice(0, -1)
    : outcome.error.steps
  ).flatMap((step) => step.responseMessages);
