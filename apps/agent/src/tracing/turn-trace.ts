import { asc } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { ReasoningEffortSchema } from "../model-gateway/model-provider.ts";
import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { turnResults, turnTraces } from "../personal-agent/storage-schema.ts";

export const PromptMessageSchema = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
});

export type PromptMessage = typeof PromptMessageSchema.Type;

const TraceUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
});

const ToolCallSchema = Schema.Struct({
  name: Schema.String,
  input: Schema.String,
  output: Schema.String,
});

const TraceBodySchema = Schema.Struct({
  task: Schema.Literal("reply"),
  modelId: Schema.String,
  modelSettings: Schema.Struct({
    attempts: Schema.Number,
    attemptTimeoutMillis: Schema.Number,
    reasoningEffort: Schema.optionalKey(ReasoningEffortSchema),
  }),
  system: Schema.String,
  messages: Schema.Array(PromptMessageSchema),
  toolCalls: Schema.Array(ToolCallSchema),
  reply: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  usage: TraceUsageSchema,
  modelLatencyMillis: Schema.Number,
});

export const TurnTraceSchema = Schema.Struct({
  eventId: Schema.String,
  result: Schema.Literals(turnResults),
  ...TraceBodySchema.fields,
});

export type TurnTrace = typeof TurnTraceSchema.Type;

export interface StoredTurnTrace {
  readonly sequence: number;
  readonly ownerId: OwnerId;
  readonly recordedAt: string;
  readonly trace: TurnTrace;
}

const BodyJsonSchema = Schema.fromJsonString(TraceBodySchema);

const encodeBody = Schema.encodeSync(BodyJsonSchema);
const decodeBody = Schema.decodeUnknownSync(BodyJsonSchema);

const toStoredTrace = (
  row: typeof turnTraces.$inferSelect
): StoredTurnTrace => ({
  sequence: row.sequence,
  ownerId: OwnerIdSchema.make(row.ownerId),
  recordedAt: row.recordedAt,
  trace: {
    eventId: row.eventId,
    result: row.result,
    ...decodeBody(row.record),
  },
});

const makeTurnTraces = (ownerId: OwnerId) =>
  Effect.gen(function* makeTurnTracesEffect() {
    const { database } = yield* AgentStorage;

    const record = ({ eventId, result, ...body }: TurnTrace) =>
      database
        .insert(turnTraces)
        .values({
          ownerId,
          recordedAt: new Date().toISOString(),
          eventId,
          result,
          record: encodeBody(body),
        })
        .pipe(Effect.asVoid);

    const read = database
      .select()
      .from(turnTraces)
      .orderBy(asc(turnTraces.sequence))
      .pipe(Effect.map((rows) => rows.map(toStoredTrace)));

    return { record, read };
  });

export class TurnTraces extends Context.Service<
  TurnTraces,
  Effect.Success<ReturnType<typeof makeTurnTraces>>
>()("TurnTraces") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(TurnTraces, makeTurnTraces(ownerId));
}
