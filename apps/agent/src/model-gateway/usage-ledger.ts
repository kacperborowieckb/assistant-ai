import { asc } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { modelUsage } from "../personal-agent/storage-schema.ts";
import type { ModelTask } from "./model-provider.ts";

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

const toUsageRecord = (row: typeof modelUsage.$inferSelect): UsageRecord => ({
  ownerId: row.ownerId,
  task: row.task,
  modelId: row.modelId,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cachedInputTokens: row.cachedInputTokens,
  costUsd: row.costUsd,
});

const makeUsageLedger = (ownerId: OwnerId) =>
  Effect.gen(function* makeUsageLedgerEffect() {
    const { database } = yield* AgentStorage;

    const record = (task: ModelTask, modelId: string, usage: Usage) =>
      database.insert(modelUsage).values({
        ownerId,
        recordedAt: new Date().toISOString(),
        task,
        modelId,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        costUsd: usage.costUsd ?? null,
      });

    const read = database
      .select()
      .from(modelUsage)
      .orderBy(asc(modelUsage.sequence))
      .pipe(Effect.map((rows) => rows.map(toUsageRecord)));

    return { record, read };
  });

export class UsageLedger extends Context.Service<
  UsageLedger,
  Effect.Success<ReturnType<typeof makeUsageLedger>>
>()("UsageLedger") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(UsageLedger, makeUsageLedger(ownerId));
}
