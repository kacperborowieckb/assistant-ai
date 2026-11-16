import { DateTime, Option, Schema } from "effect";

export const localDueTimePattern =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/u;

export const LocalDueTimeSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(localDueTimePattern))
);

export const localDueTimeFormat = "YYYY-MM-DDTHH:mm";

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const partsOf = (local: string): Option.Option<LocalParts> =>
  Option.fromNullishOr(localDueTimePattern.exec(local)?.groups).pipe(
    Option.map(({ year, month, day, hour, minute }) => ({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    }))
  );

const isRealCalendarTime = (parts: LocalParts) => {
  const check = DateTime.toParts(DateTime.makeUnsafe(parts));
  return (
    check.year === parts.year &&
    check.month === parts.month &&
    check.day === parts.day &&
    check.hour === parts.hour &&
    check.minute === parts.minute
  );
};

export const instantOfLocalDueTime = (
  local: string,
  timeZone: DateTime.TimeZone
): Option.Option<DateTime.Utc> =>
  partsOf(local).pipe(
    Option.filter(isRealCalendarTime),
    Option.flatMap((parts) =>
      DateTime.makeZoned(parts, {
        timeZone,
        adjustForTimeZone: true,
        disambiguation: "later",
      })
    ),
    Option.map(DateTime.toUtc)
  );
