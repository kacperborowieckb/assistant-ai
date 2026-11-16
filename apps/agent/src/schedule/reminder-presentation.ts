import type { DateTime } from "effect";

import { localTimeOf } from "../time/local-time.ts";
import type { Schedule } from "./schedule.ts";

export const reminderOf = (
  schedule: Schedule,
  timeZone: DateTime.TimeZone.Named
) => ({
  scheduleId: schedule.scheduleId,
  text: schedule.text,
  noteId: schedule.noteId ?? null,
  due: localTimeOf(schedule.nextDueAt, timeZone),
});

export const noActiveReminderMessage = (scheduleId: string) =>
  `No active Reminder has the id ${scheduleId}. It is unknown, or it is already done or cancelled. Nothing was changed. Tell the Owner this, and call list_reminders when you need the ids of the active Reminders.`;
