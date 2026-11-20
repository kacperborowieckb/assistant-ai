import { DateTime, Option, Schema } from "effect";

import type { schedules } from "../personal-agent/storage-schema.ts";
import type {
  scheduleSetBy,
  scheduleStates,
} from "../personal-agent/storage-values.ts";
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
  readonly openLoopIds: readonly string[];
  readonly nextDueAt: DateTime.Utc;
  readonly createdAt: DateTime.Utc;
  readonly repeat: Repeat | undefined;
  readonly state: (typeof scheduleStates)[number];
}

export interface SetScheduleRequest {
  readonly action: ScheduleAction;
  readonly setBy: Schedule["setBy"];
  readonly noteId?: string | undefined;
  readonly openLoopIds?: readonly string[] | undefined;
  readonly dueAt: DateTime.Utc;
  readonly repeat?: Repeat | undefined;
  readonly sourceEventId: string;
  readonly activeScheduledTaskLimit?: number | undefined;
  readonly activeAgentScheduleLimit?: number | undefined;
}

export interface ScheduleSet {
  readonly schedule: Schedule;
  readonly alreadySet: boolean;
}

export interface ScheduleChangeRequest {
  readonly scheduleId: string;
  readonly action?: ScheduleAction | undefined;
  readonly dueAt?: DateTime.Utc | undefined;
  readonly repeat?: Repeat | undefined;
  readonly eventId: string;
  readonly activeScheduledTaskLimit?: number | undefined;
}

export interface ScheduleCancelRequest {
  readonly scheduleId: string;
  readonly eventId: string;
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

export const toSchedule = (
  row: typeof schedules.$inferSelect,
  openLoopIds: readonly string[] = []
): Schedule => ({
  scheduleId: row.scheduleId,
  setBy: row.setBy,
  action: actionOfColumns({ action: row.action, text: row.text }),
  noteId: row.noteId ?? undefined,
  openLoopIds,
  nextDueAt: DateTime.makeUnsafe(row.nextDueAt),
  createdAt: DateTime.makeUnsafe(row.createdAt),
  repeat: repeatOf(row),
  state: row.state,
});

export const recurrenceValuesOf = (repeat: Repeat | undefined) => ({
  recurrence: repeat === undefined ? null : encodeRule(repeat.rule),
  recurrenceTimeZone:
    repeat === undefined ? null : DateTime.zoneToString(repeat.timeZone),
});

export const requestKeyOf = ({
  action,
  dueAt,
  noteId,
  openLoopIds = [],
  repeat,
  setBy,
}: SetScheduleRequest) =>
  JSON.stringify([
    action._tag === "SendText" ? action.text : { prompt: action.prompt },
    noteId ?? null,
    repeat === undefined
      ? [DateTime.formatIso(dueAt)]
      : [encodeRule(repeat.rule), DateTime.zoneToString(repeat.timeZone)],
    ...(openLoopIds.length === 0 ? [] : [openLoopIds.toSorted()]),
    ...(setBy === "agent" ? ["agent"] : []),
  ]);
