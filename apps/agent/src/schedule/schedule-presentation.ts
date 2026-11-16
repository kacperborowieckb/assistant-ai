import { DateTime } from "effect";

import { localTimeOf } from "../time/local-time.ts";
import type { Schedule } from "./schedule.ts";

export const scheduleOf = (
  schedule: Schedule,
  timeZone: DateTime.TimeZone.Named
) => ({
  scheduleId: schedule.scheduleId,
  action: schedule.action,
  noteId: schedule.noteId ?? null,
  due: localTimeOf(schedule.nextDueAt, schedule.repeat?.timeZone ?? timeZone),
  repeats:
    schedule.repeat === undefined
      ? null
      : {
          rule: schedule.repeat.rule,
          timeZone: DateTime.zoneToString(schedule.repeat.timeZone),
        },
});

export const noActiveScheduleMessage = (scheduleId: string) =>
  `No active Schedule has the id ${scheduleId}. It is unknown, or it is already done or cancelled. Nothing was changed. Tell the Owner this, and call list_schedules when you need the ids of the active Schedules.`;
