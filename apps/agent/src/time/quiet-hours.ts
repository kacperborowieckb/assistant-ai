import { DateTime, Option, Schema } from "effect";

import { nextOccurrence } from "./next-occurrence.ts";
import { LocalClockTimeSchema } from "./recurrence-rule.ts";

export const QuietHoursSchema = Schema.Struct({
  start: LocalClockTimeSchema,
  end: LocalClockTimeSchema,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      ({ start, end }) =>
        start !== end || "Quiet Hours need a start that differs from the end"
    )
  )
);

export type QuietHours = typeof QuietHoursSchema.Type;

const minutesOfDay = (clockTime: string) => {
  const [hour = 0, minute = 0] = clockTime.split(":").map(Number);
  return hour * 60 + minute;
};

const isQuietAt = ({ start, end }: QuietHours, localMinutes: number) => {
  const from = minutesOfDay(start);
  const until = minutesOfDay(end);
  return from < until
    ? localMinutes >= from && localMinutes < until
    : localMinutes >= from || localMinutes < until;
};

export const endOfQuietHours = (
  quietHours: QuietHours,
  now: DateTime.Utc,
  timeZone: DateTime.TimeZone
): Option.Option<DateTime.Utc> => {
  const local = DateTime.toParts(DateTime.setZone(now, timeZone));
  if (!isQuietAt(quietHours, local.hour * 60 + local.minute)) {
    return Option.none();
  }
  return Option.some(
    nextOccurrence({ _tag: "Daily", time: quietHours.end }, now, timeZone)
  );
};
