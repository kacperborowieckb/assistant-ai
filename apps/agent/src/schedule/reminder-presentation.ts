import { DateTime } from "effect";

import { localTimeOf } from "../time/local-time.ts";
import { textOfAction } from "./schedule-action.ts";
import type { Schedule } from "./schedule.ts";

export const reminderOf = (
  schedule: Schedule,
  timeZone: DateTime.TimeZone.Named
) => ({
  scheduleId: schedule.scheduleId,
  text: textOfAction(schedule.action),
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

export const noActiveReminderMessage = (scheduleId: string) =>
  `No active Reminder has the id ${scheduleId}. It is unknown, or it is already done or cancelled. Nothing was changed. Tell the Owner this, and call list_reminders when you need the ids of the active Reminders.`;
