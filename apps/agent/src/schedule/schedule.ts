import { DateTime, Option, Schema } from "effect";

import type {
  scheduleSetBy,
  scheduleStates,
  schedules,
} from "../personal-agent/storage-schema.ts";
import { RecurrenceRuleJsonSchema } from "../time/recurrence-rule.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import { namedTimeZone } from "../time/time-zone.ts";
import { actionOfColumns } from "./schedule-action.ts";
import type { ScheduleAction } from "./schedule-action.ts";

export interface Repeat {
  readonly rule: RecurrenceRule;
  readonly timeZone: DateTime.TimeZone.Named;
}

export interface Schedule {
  readonly scheduleId: string;
  readonly setBy: (typeof scheduleSetBy)[number];
  readonly action: ScheduleAction;
  readonly noteId: string | undefined;
  readonly nextDueAt: DateTime.Utc;
  readonly createdAt: DateTime.Utc;
  readonly repeat: Repeat | undefined;
  readonly state: (typeof scheduleStates)[number];
}

const decodeRule = Schema.decodeUnknownSync(RecurrenceRuleJsonSchema);

export const encodeRule = Schema.encodeSync(RecurrenceRuleJsonSchema);

const repeatOf = ({
  recurrence,
  recurrenceTimeZone,
}: typeof schedules.$inferSelect): Repeat | undefined => {
  if (recurrence === null || recurrenceTimeZone === null) {
    return undefined;
  }
  return {
    rule: decodeRule(recurrence),
    timeZone: Option.getOrThrowWith(
      namedTimeZone(recurrenceTimeZone),
      () => new Error("A stored Schedule has an unknown time zone")
    ),
  };
};

export const toSchedule = (row: typeof schedules.$inferSelect): Schedule => ({
  scheduleId: row.scheduleId,
  setBy: row.setBy,
  action: actionOfColumns({ action: row.action, text: row.text }),
  noteId: row.noteId ?? undefined,
  nextDueAt: DateTime.makeUnsafe(row.nextDueAt),
  createdAt: DateTime.makeUnsafe(row.createdAt),
  repeat: repeatOf(row),
  state: row.state,
});
