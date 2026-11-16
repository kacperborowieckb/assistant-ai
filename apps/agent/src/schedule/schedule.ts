import { DateTime } from "effect";

import type {
  scheduleKinds,
  scheduleSetBy,
  scheduleStates,
  schedules,
} from "../personal-agent/storage-schema.ts";

export interface Schedule {
  readonly scheduleId: string;
  readonly kind: (typeof scheduleKinds)[number];
  readonly setBy: (typeof scheduleSetBy)[number];
  readonly text: string;
  readonly noteId: string | undefined;
  readonly nextDueAt: DateTime.Utc;
  readonly state: (typeof scheduleStates)[number];
}

export const toSchedule = (row: typeof schedules.$inferSelect): Schedule => ({
  scheduleId: row.scheduleId,
  kind: row.kind,
  setBy: row.setBy,
  text: row.text,
  noteId: row.noteId ?? undefined,
  nextDueAt: DateTime.makeUnsafe(row.nextDueAt),
  state: row.state,
});
