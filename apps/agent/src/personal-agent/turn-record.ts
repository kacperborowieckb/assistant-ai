import { Clock, Effect } from "effect";

import {
  attemptTimeoutMillis,
  modelAttempts,
} from "../model-gateway/model-gateway.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import type { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import type { OwnerId } from "../owner-id.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { PromptMessage, TurnTrace } from "../tracing/turn-trace.ts";
import type { InboxEvent } from "./inbox.ts";

export const modelFailureReason = (
  error: ModelUnavailable,
  redactor: Redactor["Service"]
) =>
  redactor.redact(
    `The model failed ${modelAttempts} times: ${String(error.cause)}`
  );

export type ModelOutcome =
  | { readonly _tag: "Replied"; readonly reply: ModelReply }
  | { readonly _tag: "ModelFailed"; readonly error: ModelUnavailable };

interface TraceInput {
  readonly event: InboxEvent;
  readonly system: string;
  readonly messages: readonly PromptMessage[];
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
      usage: outcome._tag === "Replied" ? outcome.reply.usage : undefined,
    });
  });
