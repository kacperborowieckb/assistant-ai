import { DateTime } from "effect";

export const startOfLocalDay = (
  instant: DateTime.Utc,
  timeZone: DateTime.TimeZone
): DateTime.Utc =>
  DateTime.toUtc(DateTime.startOf(DateTime.setZone(instant, timeZone), "day"));
