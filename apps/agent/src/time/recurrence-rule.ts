import { Schema } from "effect";

export const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const localClockTimeFormat = "HH:mm";

export const LocalClockTimeSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)),
  Schema.annotate({
    description: `The local time of day as ${localClockTimeFormat} in 24 hours, for example 09:00.`,
  })
);

const DailySchema = Schema.Struct({
  _tag: Schema.Literal("Daily"),
  time: LocalClockTimeSchema,
}).annotate({ description: "Every day at the local time." });

const WeeklySchema = Schema.Struct({
  _tag: Schema.Literal("Weekly"),
  weekdays: Schema.NonEmptyArray(Schema.Literals(weekdayNames)).annotate({
    description: "The weekdays on which the Reminder fires.",
  }),
  time: LocalClockTimeSchema,
}).annotate({ description: "On the listed weekdays at the local time." });

const MonthlySchema = Schema.Struct({
  _tag: Schema.Literal("Monthly"),
  day: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
    Schema.Literal("last"),
  ]).annotate({
    description:
      'The day of the month from 1 to 31, or "last" for the last day of each month. A day that the month does not have, such as 31 in April, fires on the last day of that month.',
  }),
  time: LocalClockTimeSchema,
}).annotate({ description: "Once each month at the local time." });

export const RecurrenceRuleSchema = Schema.Union([
  DailySchema,
  WeeklySchema,
  MonthlySchema,
]);

export type RecurrenceRule = typeof RecurrenceRuleSchema.Type;

export const RecurrenceRuleJsonSchema =
  Schema.fromJsonString(RecurrenceRuleSchema);
