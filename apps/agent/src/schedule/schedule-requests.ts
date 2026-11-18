import { DateTime } from "effect";
import type { Option } from "effect";

import type { schedules } from "../personal-agent/storage-schema.ts";
import type { ScheduleAction } from "./schedule-action.ts";
import { encodeRule } from "./schedule.ts";
import type { Repeat, Schedule } from "./schedule.ts";

export interface SetScheduleRequest {
  readonly action: ScheduleAction;
  readonly setBy: Schedule["setBy"];
  readonly noteId?: string | undefined;
  readonly dueAt: DateTime.Utc;
  readonly repeat?: Repeat | undefined;
  readonly sourceEventId: string;
  readonly activeScheduledTaskLimit?: number | undefined;
}

export interface ScheduleSet {
  readonly schedule: Schedule;
  readonly alreadySet: boolean;
}

export interface AlarmClock {
  readonly setAt: (dueAt: Option.Option<DateTime.Utc>) => Promise<void>;
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

export interface ScheduleEditValues {
  readonly action?: (typeof schedules.$inferSelect)["action"];
  readonly text?: string;
  readonly nextDueAt?: string;
  readonly recurrence?: string | null;
  readonly recurrenceTimeZone?: string | null;
  readonly state?: "cancelled" | "done";
  readonly changedAt?: string;
}

export const recurrenceValuesOf = (repeat: Repeat | undefined) => ({
  recurrence: repeat === undefined ? null : encodeRule(repeat.rule),
  recurrenceTimeZone:
    repeat === undefined ? null : DateTime.zoneToString(repeat.timeZone),
});

export const requestKeyOf = ({
  action,
  dueAt,
  noteId,
  repeat,
}: SetScheduleRequest) =>
  JSON.stringify([
    action._tag === "SendText" ? action.text : { prompt: action.prompt },
    noteId ?? null,
    repeat === undefined
      ? [DateTime.formatIso(dueAt)]
      : [encodeRule(repeat.rule), DateTime.zoneToString(repeat.timeZone)],
  ]);
