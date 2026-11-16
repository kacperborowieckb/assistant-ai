import { asc } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { ModelMessageSchema } from "../model-gateway/model-message-schema.ts";
import { ReasoningEffortSchema } from "../model-gateway/model-provider.ts";
import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { turnResults, turnTraces } from "../personal-agent/storage-schema.ts";

const TraceUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
});

const ToolCallSchema = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  input: Schema.String,
  output: Schema.String,
  failed: Schema.Boolean,
});

const TraceStepSchema = Schema.Struct({
  toolCalls: Schema.Array(ToolCallSchema),
  usage: TraceUsageSchema,
});

const ReplyTraceBodySchema = Schema.Struct({
  task: Schema.Literal("reply"),
  modelId: Schema.String,
  modelSettings: Schema.Struct({
    attempts: Schema.Number,
    attemptTimeoutMillis: Schema.Number,
    reasoningEffort: Schema.optionalKey(ReasoningEffortSchema),
  }),
  system: Schema.String,
  messages: Schema.Array(ModelMessageSchema),
  steps: Schema.Array(TraceStepSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  reply: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  usage: TraceUsageSchema,
  modelLatencyMillis: Schema.Number,
});

const ReminderDeliveryTraceBodySchema = Schema.Struct({
  task: Schema.Literal("reminder_delivery"),
  scheduleId: Schema.String,
  dueAt: Schema.String,
  late: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  text: Schema.String,
  channelMessageId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  latencyMillis: Schema.Number,
});

const TraceBodySchema = Schema.Union([
  ReplyTraceBodySchema,
  ReminderDeliveryTraceBodySchema,
]);

const traceFields = {
  eventId: Schema.String,
  result: Schema.Literals(turnResults),
};

export const ReplyTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ReplyTraceBodySchema.fields,
});

export const ReminderDeliveryTurnTraceSchema = Schema.Struct({
  ...traceFields,
  ...ReminderDeliveryTraceBodySchema.fields,
});

export const TurnTraceSchema = Schema.Union([
  ReplyTurnTraceSchema,
  ReminderDeliveryTurnTraceSchema,
]);

export type ReplyTurnTrace = typeof ReplyTurnTraceSchema.Type;

export type ReminderDeliveryTurnTrace =
  typeof ReminderDeliveryTurnTraceSchema.Type;

export type TurnTrace = typeof TurnTraceSchema.Type;

export interface StoredTurnTrace<Trace extends TurnTrace = TurnTrace> {
  readonly sequence: number;
  readonly ownerId: OwnerId;
  readonly recordedAt: string;
  readonly trace: Trace;
}

export type StoredReplyTurnTrace = StoredTurnTrace<ReplyTurnTrace>;

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

    const readReplies = read.pipe(
      Effect.map((stored) =>
        stored.flatMap(({ trace, ...rest }) =>
          trace.task === "reply" ? [{ ...rest, trace }] : []
        )
      )
    );

    return { record, read, readReplies };
  });

export class TurnTraces extends Context.Service<
  TurnTraces,
  Effect.Success<ReturnType<typeof makeTurnTraces>>
>()("TurnTraces") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(TurnTraces, makeTurnTraces(ownerId));
}
