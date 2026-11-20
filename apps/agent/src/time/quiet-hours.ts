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

export const endOfQuietHours = (
  { start, end }: QuietHours,
  now: DateTime.Utc,
  timeZone: DateTime.TimeZone
): Option.Option<DateTime.Utc> => {
  const nextEnd = nextOccurrence({ _tag: "Daily", time: end }, now, timeZone);
  const nextStart = nextOccurrence(
    { _tag: "Daily", time: start },
    now,
    timeZone
  );
  return DateTime.isLessThan(nextEnd, nextStart)
    ? Option.some(nextEnd)
    : Option.none();
};

export const quietHoursText = ({ start, end }: QuietHours) => `${start}-${end}`;

export const sameQuietHours = (left: QuietHours, right: QuietHours) =>
  left.start === right.start && left.end === right.end;
