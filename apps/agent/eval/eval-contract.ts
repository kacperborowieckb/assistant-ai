import { Schema } from "effect";

import {
  trustLevels,
  modelTasks,
  profileEntryKinds,
} from "../src/personal-agent/storage-values.ts";

export const evalRoutes = {
  seed: "/eval/seed",
  observation: "/eval/observation",
  judge: "/eval/judge",
} as const;

export const NonEmptyString = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1))
);

export const SeedNoteSchema = Schema.Struct({
  text: NonEmptyString,
  url: Schema.optionalKey(NonEmptyString),
  forwardedFrom: Schema.optionalKey(NonEmptyString),
});

export type SeedNote = typeof SeedNoteSchema.Type;

export const SeedProfileEntrySchema = Schema.Struct({
  kind: Schema.Literals(profileEntryKinds),
  text: NonEmptyString,
});

export type SeedProfileEntry = typeof SeedProfileEntrySchema.Type;

export const SeedRequestSchema = Schema.Struct({
  ownerId: NonEmptyString,
  conversationId: NonEmptyString,
  notes: Schema.Array(SeedNoteSchema),
  profile: Schema.Array(SeedProfileEntrySchema),
});

export type SeedRequest = typeof SeedRequestSchema.Type;

export const SeedResponseSchema = Schema.Struct({
  seededNoteCount: Schema.Int,
  seededProfileEntryCount: Schema.Int,
});

export type SeedResponse = typeof SeedResponseSchema.Type;

export const ObservationRequestSchema = Schema.Struct({
  ownerId: NonEmptyString,
});

export type ObservationRequest = typeof ObservationRequestSchema.Type;

export const ObservedNoteSchema = Schema.Struct({
  noteId: Schema.String,
  text: Schema.String,
  url: Schema.optionalKey(Schema.String),
  trustLevel: Schema.Literals(trustLevels),
  forwardOrigin: Schema.optionalKey(Schema.String),
  linkedNoteIds: Schema.Array(Schema.String),
});

export type ObservedNote = typeof ObservedNoteSchema.Type;

export const ObservedProfileEntrySchema = Schema.Struct({
  kind: Schema.Literals(profileEntryKinds),
  text: Schema.String,
});

export type ObservedProfileEntry = typeof ObservedProfileEntrySchema.Type;

export const ObservedToolCallSchema = Schema.Struct({
  eventId: Schema.String,
  name: Schema.String,
  input: Schema.String,
  output: Schema.String,
  failed: Schema.Boolean,
});

export type ObservedToolCall = typeof ObservedToolCallSchema.Type;

export const ObservedUsageSchema = Schema.Struct({
  task: Schema.Literals(modelTasks),
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
});

export type ObservedUsage = typeof ObservedUsageSchema.Type;

export const AgentObservationSchema = Schema.Struct({
  pendingEventCount: Schema.Int,
  notes: Schema.Array(ObservedNoteSchema),
  profile: Schema.Array(ObservedProfileEntrySchema),
  toolCalls: Schema.Array(ObservedToolCallSchema),
  usage: Schema.Array(ObservedUsageSchema),
});

export type AgentObservation = typeof AgentObservationSchema.Type;

export const ExchangeSchema = Schema.Struct({
  ownerText: Schema.String,
  forwardedFrom: Schema.optionalKey(Schema.String),
  agentReply: Schema.NullOr(Schema.String),
});

export type Exchange = typeof ExchangeSchema.Type;

export const JudgedToolCallSchema = Schema.Struct({
  name: Schema.String,
  input: Schema.String,
  output: Schema.String,
});

export type JudgedToolCall = typeof JudgedToolCallSchema.Type;

export const JudgeRequestSchema = Schema.Struct({
  ownerId: NonEmptyString,
  rubric: NonEmptyString,
  exchanges: Schema.Array(ExchangeSchema),
  toolCalls: Schema.Array(JudgedToolCallSchema),
});

export type JudgeRequest = typeof JudgeRequestSchema.Type;

export const JudgeResultSchema = Schema.Struct({
  passed: Schema.Boolean,
  reason: Schema.String,
  usage: Schema.Array(ObservedUsageSchema),
});

export type JudgeResult = typeof JudgeResultSchema.Type;
