import { DateTime } from "effect";

import { localTimeOf } from "../time/local-time.ts";

export const lateReminderText = (
  text: string,
  dueAt: DateTime.Utc,
  timeZone: DateTime.TimeZone
) =>
  `This Reminder is late. It was due ${localTimeOf(dueAt, timeZone)} (${DateTime.zoneToString(timeZone)}): ${text}`;
