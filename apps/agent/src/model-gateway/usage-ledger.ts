import { Context, Effect, Layer, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import type { ModelTask } from "./model-provider.ts";

export const usageSchema = [
  `CREATE TABLE IF NOT EXISTS model_usage (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    task TEXT NOT NULL,
    model_id TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    cost_usd REAL
  )`,
];

export interface Usage {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly costUsd: number | undefined;
}

export const UsageRecordSchema = Schema.Struct({
  ownerId: OwnerIdSchema,
  task: Schema.Literal("reply"),
  modelId: Schema.String,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
});

export type UsageRecord = typeof UsageRecordSchema.Type;

const UsageRowSchema = Schema.Struct({
  owner_id: OwnerIdSchema,
  task: Schema.Literal("reply"),
  model_id: Schema.String,
  input_tokens: Schema.NullOr(Schema.Number),
  output_tokens: Schema.NullOr(Schema.Number),
  cached_input_tokens: Schema.NullOr(Schema.Number),
  cost_usd: Schema.NullOr(Schema.Number),
});

const toUsageRecord = (row: typeof UsageRowSchema.Type): UsageRecord => ({
  ownerId: row.owner_id,
  task: row.task,
  modelId: row.model_id,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cachedInputTokens: row.cached_input_tokens,
  costUsd: row.cost_usd,
});

const decodeUsageRows = Schema.decodeUnknownSync(Schema.Array(UsageRowSchema));

const makeUsageLedger = (ownerId: OwnerId) =>
  Effect.gen(function* makeUsageLedgerEffect() {
    const { sql } = yield* AgentStorage;

    const record = (task: ModelTask, modelId: string, usage: Usage) =>
      Effect.sync(() => {
        sql.exec(
          `INSERT INTO model_usage
            (owner_id, recorded_at, task, model_id, input_tokens, output_tokens, cached_input_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ownerId,
          new Date().toISOString(),
          task,
          modelId,
          usage.inputTokens ?? null,
          usage.outputTokens ?? null,
          usage.cachedInputTokens ?? null,
          usage.costUsd ?? null
        );
      });

    const read = Effect.sync(() =>
      decodeUsageRows(
        sql
          .exec(
            `SELECT owner_id, task, model_id, input_tokens, output_tokens, cached_input_tokens, cost_usd
             FROM model_usage ORDER BY sequence`
          )
          .toArray()
      ).map(toUsageRecord)
    );

    return { record, read };
  });

export class UsageLedger extends Context.Service<
  UsageLedger,
  Effect.Success<ReturnType<typeof makeUsageLedger>>
>()("UsageLedger") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(UsageLedger, makeUsageLedger(ownerId));
}
