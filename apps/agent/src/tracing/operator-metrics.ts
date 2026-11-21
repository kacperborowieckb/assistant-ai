import { Context, Effect, Layer } from "effect";

import type { Usage } from "../model-gateway/usage-ledger.ts";
import type { OwnerId } from "../owner-id.ts";
import { proactiveOutcomes } from "../personal-agent/storage-values.ts";
import type { OutcomeKind } from "../personal-agent/storage-values.ts";

export const turnMetricResults = [
  "replied",
  "reacted",
  "silent",
  "model_failed",
  "send_failed",
  "superseded",
] as const;

export const reminderMetricResults = ["delivered", "delivery_failed"] as const;

export const skipMetricResults = ["daily_token_budget_spent"] as const;

export const proactiveMetricResults = ["sent", "folded", "skipped"] as const;

export const outcomeMetricResults = proactiveOutcomes;

export const refusalReasons = [
  "bad_secret_token",
  "unknown_sender",
  "owner_not_active",
] as const;

export type OperatorMetric =
  | {
      readonly kind: "turn";
      readonly ownerId: OwnerId;
      readonly eventId: string;
      readonly result: (typeof turnMetricResults)[number];
      readonly outcome: OutcomeKind | undefined;
      readonly latencyMillis: number;
      readonly modelId: string;
      readonly usage: Usage | undefined;
      readonly stepCount: number;
      readonly toolCallCount: number;
      readonly restartCount: number;
    }
  | {
      readonly kind: "reminder";
      readonly ownerId: OwnerId;
      readonly eventId: string;
      readonly result: (typeof reminderMetricResults)[number];
      readonly latencyMillis: number;
    }
  | {
      readonly kind: "scheduled_task_skipped";
      readonly ownerId: OwnerId;
      readonly eventId: string;
      readonly result: (typeof skipMetricResults)[number];
      readonly latencyMillis: number;
    }
  | {
      readonly kind: "proactive_message";
      readonly ownerId: OwnerId;
      readonly eventId: string;
      readonly result: (typeof proactiveMetricResults)[number];
      readonly latencyMillis: number;
    }
  | {
      readonly kind: "outcome";
      readonly ownerId: OwnerId;
      readonly eventId: string;
      readonly result: (typeof outcomeMetricResults)[number];
      readonly latencyMillis: number;
    }
  | {
      readonly kind: "refused";
      readonly ownerId: OwnerId | undefined;
      readonly result: (typeof refusalReasons)[number];
      readonly latencyMillis: number;
    };

export const noOwnerIndex = "none";

const costBlob = (usage: Usage | undefined) => {
  if (usage === undefined) {
    return "";
  }
  return usage.costUsd === undefined ? "cost_unknown" : "cost_known";
};

const dataPointOf = (metric: OperatorMetric): AnalyticsEngineDataPoint => {
  const usage = metric.kind === "turn" ? metric.usage : undefined;
  return {
    indexes: [metric.ownerId ?? noOwnerIndex],
    blobs: [
      metric.kind,
      metric.result,
      metric.kind === "turn" ? metric.modelId : "",
      costBlob(usage),
      "eventId" in metric ? metric.eventId : "",
      ...(metric.kind === "turn" ? [metric.outcome ?? ""] : []),
    ],
    doubles: [
      metric.latencyMillis,
      usage?.inputTokens ?? 0,
      usage?.outputTokens ?? 0,
      usage?.costUsd ?? 0,
      usage?.cachedInputTokens ?? 0,
      metric.kind === "turn" ? metric.stepCount : 0,
      metric.kind === "turn" ? metric.toolCallCount : 0,
      metric.kind === "turn" ? metric.restartCount : 0,
    ],
  };
};

const makeOperatorMetrics = (dataset: AnalyticsEngineDataset) => ({
  record: (metric: OperatorMetric) =>
    Effect.sync(() => {
      dataset.writeDataPoint(dataPointOf(metric));
    }).pipe(
      Effect.catchCause(() =>
        Effect.logWarning("The Operator metric could not be written")
      )
    ),
});

export class OperatorMetrics extends Context.Service<
  OperatorMetrics,
  ReturnType<typeof makeOperatorMetrics>
>()("OperatorMetrics") {
  static readonly layer = (dataset: AnalyticsEngineDataset) =>
    Layer.succeed(OperatorMetrics, makeOperatorMetrics(dataset));
}
