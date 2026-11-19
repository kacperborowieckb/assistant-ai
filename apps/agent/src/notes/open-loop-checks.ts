import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/sqlite-core";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import {
  openLoopClosedReasons,
  openLoopStates,
} from "../personal-agent/storage-values.ts";

interface OpenLoopColumns {
  readonly openLoopKind: SQLiteColumn;
  readonly openLoopState: SQLiteColumn;
  readonly openLoopClosedReason: SQLiteColumn;
  readonly openLoopDueAt: SQLiteColumn;
}

export const openLoopChecks = (columns: OpenLoopColumns) => [
  check(
    "notes_open_loop_state_check",
    valueIn(columns.openLoopState, openLoopStates)
  ),
  check(
    "notes_open_loop_closed_reason_check",
    valueIn(columns.openLoopClosedReason, openLoopClosedReasons)
  ),
  check(
    "notes_open_loop_check",
    sql`(${columns.openLoopKind} IS NULL AND ${columns.openLoopState} IS NULL AND ${columns.openLoopClosedReason} IS NULL AND ${columns.openLoopDueAt} IS NULL) OR (${columns.openLoopKind} IS NOT NULL AND trim(${columns.openLoopKind}) <> '' AND ${columns.openLoopState} IS 'open' AND ${columns.openLoopClosedReason} IS NULL) OR (${columns.openLoopKind} IS NOT NULL AND trim(${columns.openLoopKind}) <> '' AND ${columns.openLoopState} IS 'closed' AND ${columns.openLoopClosedReason} IS NOT NULL)`
  ),
];
