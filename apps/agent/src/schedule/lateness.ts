import { DateTime } from "effect";

import { localTimeOf } from "../time/local-time.ts";

export const lateReminderText = (
  text: string,
  dueAt: DateTime.Utc,
  timeZone: DateTime.TimeZone
) =>
  `This Reminder is late. It was due ${localTimeOf(dueAt, timeZone)} (${DateTime.zoneToString(timeZone)}): ${text}`;

export const lateScheduledTaskText = (
  text: string,
  dueAt: DateTime.Utc,
  timeZone: DateTime.TimeZone
) =>
  `This Scheduled Task is late. It was due ${localTimeOf(dueAt, timeZone)} (${DateTime.zoneToString(timeZone)}): ${text}`;

export const lateProactiveMessageText = (
  text: string,
  dueAt: DateTime.Utc,
  timeZone: DateTime.TimeZone
) =>
  `This message is late. It was planned for ${localTimeOf(dueAt, timeZone)} (${DateTime.zoneToString(timeZone)}): ${text}`;

export const lateByMillisOf = (now: DateTime.Utc, dueAt: DateTime.Utc) =>
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt);

export const isLate = (lateByMillis: number, graceMillis: number) =>
  lateByMillis > graceMillis;
