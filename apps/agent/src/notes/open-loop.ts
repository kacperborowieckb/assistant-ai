import { Schema, SchemaTransformation } from "effect";
import type { DateTime } from "effect";

import { openLoopCloseReasons } from "../personal-agent/storage-schema.ts";

export const OpenLoopCloseReasonSchema = Schema.Literals(openLoopCloseReasons);

export type OpenLoopCloseReason = typeof OpenLoopCloseReasonSchema.Type;

const OpenSchema = Schema.Struct({
  _tag: Schema.Literal("Open"),
  kind: Schema.String,
  dueAt: Schema.UndefinedOr(Schema.DateTimeUtc),
});

const ClosedSchema = Schema.Struct({
  _tag: Schema.Literal("Closed"),
  kind: Schema.String,
  dueAt: Schema.UndefinedOr(Schema.DateTimeUtc),
  reason: OpenLoopCloseReasonSchema,
});

const NoOpenLoopSchema = Schema.Struct({ _tag: Schema.Literal("None") });

export type OpenLoop = typeof OpenSchema.Type | typeof ClosedSchema.Type;

export type OpenLoopOpen = typeof OpenSchema.Type;

const DueColumnSchema = Schema.NullOr(Schema.DateTimeUtcFromString);

const NoOpenLoopColumnsSchema = Schema.Struct({
  openLoopKind: Schema.Null,
  openLoopDueAt: Schema.Null,
  openLoopState: Schema.Null,
  openLoopCloseReason: Schema.Null,
}).pipe(
  Schema.decodeTo(
    NoOpenLoopSchema,
    SchemaTransformation.transform({
      decode: () => ({ _tag: "None" as const }),
      encode: () => ({
        openLoopKind: null,
        openLoopDueAt: null,
        openLoopState: null,
        openLoopCloseReason: null,
      }),
    })
  )
);

const OpenColumnsSchema = Schema.Struct({
  openLoopKind: Schema.String,
  openLoopDueAt: DueColumnSchema,
  openLoopState: Schema.Literal("open"),
  openLoopCloseReason: Schema.Null,
}).pipe(
  Schema.decodeTo(
    OpenSchema,
    SchemaTransformation.transform({
      decode: ({ openLoopKind, openLoopDueAt }) => ({
        _tag: "Open" as const,
        kind: openLoopKind,
        dueAt: openLoopDueAt ?? undefined,
      }),
      encode: ({ kind, dueAt }) => ({
        openLoopKind: kind,
        openLoopDueAt: dueAt ?? null,
        openLoopState: "open" as const,
        openLoopCloseReason: null,
      }),
    })
  )
);

const ClosedColumnsSchema = Schema.Struct({
  openLoopKind: Schema.String,
  openLoopDueAt: DueColumnSchema,
  openLoopState: Schema.Literal("closed"),
  openLoopCloseReason: OpenLoopCloseReasonSchema,
}).pipe(
  Schema.decodeTo(
    ClosedSchema,
    SchemaTransformation.transform({
      decode: ({ openLoopKind, openLoopDueAt, openLoopCloseReason }) => ({
        _tag: "Closed" as const,
        kind: openLoopKind,
        dueAt: openLoopDueAt ?? undefined,
        reason: openLoopCloseReason,
      }),
      encode: ({ kind, dueAt, reason }) => ({
        openLoopKind: kind,
        openLoopDueAt: dueAt ?? null,
        openLoopState: "closed" as const,
        openLoopCloseReason: reason,
      }),
    })
  )
);

const OpenLoopColumnsSchema = Schema.Union([
  NoOpenLoopColumnsSchema,
  OpenColumnsSchema,
  ClosedColumnsSchema,
]);

const decodeColumns = Schema.decodeUnknownSync(OpenLoopColumnsSchema);

const encodeColumns = Schema.encodeSync(OpenLoopColumnsSchema);

export interface OpenLoopColumns {
  readonly openLoopKind: string | null;
  readonly openLoopDueAt: string | null;
  readonly openLoopState: "open" | "closed" | null;
  readonly openLoopCloseReason: OpenLoopCloseReason | null;
}

export const openLoopOfColumns = (
  columns: OpenLoopColumns
): OpenLoop | undefined => {
  const decoded = decodeColumns(columns);
  return decoded._tag === "None" ? undefined : decoded;
};

export const columnsOfOpenLoop = (
  openLoop: OpenLoop | undefined
): OpenLoopColumns => encodeColumns(openLoop ?? { _tag: "None" });

export const sameOpenLoop = (left: OpenLoop, right: OpenLoop) =>
  left._tag === right._tag &&
  left.kind === right.kind &&
  (left.dueAt?.epochMilliseconds ?? null) ===
    (right.dueAt?.epochMilliseconds ?? null) &&
  (left._tag !== "Closed" ||
    (right._tag === "Closed" && left.reason === right.reason));

export interface OpenLoopRequest {
  readonly kind: string;
  readonly dueAt?: DateTime.Utc | undefined;
}

export interface OpenLoopUpdateRequest {
  readonly kind?: string | undefined;
  readonly dueAt?: DateTime.Utc | undefined;
}

export interface CloseOpenLoopRequest {
  readonly noteId: string;
  readonly eventId: string;
  readonly reason: OpenLoopCloseReason;
}

export const maxOpenLoopsPerPage = 10;
