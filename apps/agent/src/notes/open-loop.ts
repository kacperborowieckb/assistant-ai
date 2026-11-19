import { DateTime, Function, Schema, SchemaTransformation } from "effect";

import { openLoopClosedReasons } from "../personal-agent/storage-values.ts";

export const maxOpenLoopKindLength = 40;

export const OpenLoopKindSchema = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(maxOpenLoopKindLength))
);

export const OpenLoopClosedReasonSchema = Schema.Literals(
  openLoopClosedReasons
);

export type OpenLoopClosedReason = typeof OpenLoopClosedReasonSchema.Type;

export const OpenLoopOpenSchema = Schema.TaggedStruct("Open", {
  kind: OpenLoopKindSchema,
  dueAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export const OpenLoopClosedSchema = Schema.TaggedStruct("Closed", {
  kind: OpenLoopKindSchema,
  reason: OpenLoopClosedReasonSchema,
  dueAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export const OpenLoopSchema = Schema.Union([
  OpenLoopOpenSchema,
  OpenLoopClosedSchema,
]);

export type OpenLoopOpen = typeof OpenLoopOpenSchema.Type;
export type OpenLoopClosed = typeof OpenLoopClosedSchema.Type;
export type OpenLoop = typeof OpenLoopSchema.Type;

const NoOpenLoopColumnsSchema = Schema.Struct({
  openLoopKind: Schema.Null,
  openLoopState: Schema.Null,
  openLoopClosedReason: Schema.Null,
  openLoopDueAt: Schema.Null,
}).pipe(
  Schema.decodeTo(
    Schema.Undefined,
    SchemaTransformation.transform({
      decode: Function.constUndefined,
      encode: () => ({
        openLoopKind: null,
        openLoopState: null,
        openLoopClosedReason: null,
        openLoopDueAt: null,
      }),
    })
  )
);

const dueAtField = (dueAt: DateTime.Utc | null) =>
  dueAt === null ? {} : { dueAt };

const OpenColumnsSchema = Schema.Struct({
  openLoopKind: OpenLoopKindSchema,
  openLoopState: Schema.Literal("open"),
  openLoopClosedReason: Schema.Null,
  openLoopDueAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}).pipe(
  Schema.decodeTo(
    OpenLoopOpenSchema,
    SchemaTransformation.transform({
      decode: ({ openLoopKind, openLoopDueAt }) => ({
        _tag: "Open" as const,
        kind: openLoopKind,
        ...dueAtField(openLoopDueAt),
      }),
      encode: ({ kind, dueAt }) => ({
        openLoopKind: kind,
        openLoopState: "open" as const,
        openLoopClosedReason: null,
        openLoopDueAt: dueAt ?? null,
      }),
    })
  )
);

const ClosedColumnsSchema = Schema.Struct({
  openLoopKind: OpenLoopKindSchema,
  openLoopState: Schema.Literal("closed"),
  openLoopClosedReason: OpenLoopClosedReasonSchema,
  openLoopDueAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}).pipe(
  Schema.decodeTo(
    OpenLoopClosedSchema,
    SchemaTransformation.transform({
      decode: ({ openLoopKind, openLoopClosedReason, openLoopDueAt }) => ({
        _tag: "Closed" as const,
        kind: openLoopKind,
        reason: openLoopClosedReason,
        ...dueAtField(openLoopDueAt),
      }),
      encode: ({ kind, reason, dueAt }) => ({
        openLoopKind: kind,
        openLoopState: "closed" as const,
        openLoopClosedReason: reason,
        openLoopDueAt: dueAt ?? null,
      }),
    })
  )
);

const OpenLoopColumnsSchema = Schema.Union([
  NoOpenLoopColumnsSchema,
  OpenColumnsSchema,
  ClosedColumnsSchema,
]);

export const openLoopOfColumns = Schema.decodeUnknownSync(
  OpenLoopColumnsSchema
);

export const columnsOfOpenLoop = Schema.encodeSync(OpenLoopColumnsSchema);

export const dueAtOfOpenLoop = (openLoop: OpenLoop) =>
  openLoop.dueAt === undefined ? null : DateTime.formatIso(openLoop.dueAt);

const reasonOf = (openLoop: OpenLoop) =>
  openLoop._tag === "Closed" ? openLoop.reason : null;

export const isSameOpenLoop = (left: OpenLoop, right: OpenLoop) =>
  left._tag === right._tag &&
  left.kind === right.kind &&
  reasonOf(left) === reasonOf(right) &&
  dueAtOfOpenLoop(left) === dueAtOfOpenLoop(right);
