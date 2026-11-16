import { DateTime } from "effect";

import { weekdayNames } from "./recurrence-rule.ts";
import type { RecurrenceRule } from "./recurrence-rule.ts";

interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekDay: number;
}

const longestGapInDays = 62;

const daysInMonthOf = ({ year, month }: Pick<CalendarDay, "month" | "year">) =>
  DateTime.toParts(
    DateTime.endOf(DateTime.makeUnsafe({ year, month, day: 1 }), "month")
  ).day;

const firesOn = (rule: RecurrenceRule, day: CalendarDay) => {
  switch (rule._tag) {
    case "Daily": {
      return true;
    }
    case "Weekly": {
      return rule.weekdays.includes(weekdayNames[day.weekDay] ?? "Sunday");
    }
    case "Monthly": {
      const lastDay = daysInMonthOf(day);
      return (
        day.day ===
        (rule.day === "last" ? lastDay : Math.min(rule.day, lastDay))
      );
    }
    default: {
      return rule satisfies never;
    }
  }
};

const instantOn = (
  { year, month, day }: CalendarDay,
  time: string,
  timeZone: DateTime.TimeZone
) => {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return DateTime.toUtc(
    DateTime.makeZonedUnsafe(
      { year, month, day, hour, minute },
      { timeZone, adjustForTimeZone: true, disambiguation: "later" }
    )
  );
};

export const nextOccurrence = (
  rule: RecurrenceRule,
  after: DateTime.Utc,
  timeZone: DateTime.TimeZone
): DateTime.Utc => {
  const localToday = DateTime.toParts(DateTime.setZone(after, timeZone));
  const firstDay = DateTime.makeUnsafe({
    year: localToday.year,
    month: localToday.month,
    day: localToday.day,
  });
  for (let offset = 0; offset <= longestGapInDays; offset += 1) {
    const day = DateTime.toParts(DateTime.add(firstDay, { days: offset }));
    if (firesOn(rule, day)) {
      const instant = instantOn(day, rule.time, timeZone);
      if (DateTime.isGreaterThan(instant, after)) {
        return instant;
      }
    }
  }
  throw new Error("A recurrence rule has no occurrence within 62 days");
};
