import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { nextOccurrence } from "../src/time/next-occurrence.ts";
import { RecurrenceRuleSchema } from "../src/time/recurrence-rule.ts";
import type { RecurrenceRule } from "../src/time/recurrence-rule.ts";

const nextIso = (rule: RecurrenceRule, after: string, zoneName: string) => {
  const zone = DateTime.zoneMakeNamed(zoneName);
  if (zone._tag === "None") {
    throw new Error(`Unknown time zone ${zoneName}`);
  }
  return DateTime.formatIso(
    nextOccurrence(rule, DateTime.makeUnsafe(after), zone.value)
  );
};

const mondayAtNine: RecurrenceRule = {
  _tag: "Weekly",
  weekdays: ["Monday"],
  time: "09:00",
};

describe("nextOccurrence of a Weekly rule", () => {
  it.each([
    ["2026-03-16T12:00:00Z", "2026-03-23T08:00:00.000Z"],
    ["2026-03-23T12:00:00Z", "2026-03-30T07:00:00.000Z"],
    ["2026-10-19T12:00:00Z", "2026-10-26T08:00:00.000Z"],
    ["2026-10-12T12:00:00Z", "2026-10-19T07:00:00.000Z"],
  ])(
    "keeps Monday 09:00 in Europe/Warsaw after %s across the daylight saving changes",
    (after, expected) => {
      expect(nextIso(mondayAtNine, after, "Europe/Warsaw")).toBe(expected);
    }
  );

  it("fires later on the same day when the time has not passed", () => {
    expect(nextIso(mondayAtNine, "2026-11-16T05:00:00Z", "Europe/Warsaw")).toBe(
      "2026-11-16T08:00:00.000Z"
    );
  });

  it("does not fire at the instant it is asked after", () => {
    expect(nextIso(mondayAtNine, "2026-11-16T08:00:00Z", "Europe/Warsaw")).toBe(
      "2026-11-23T08:00:00.000Z"
    );
  });

  it("picks the nearest listed weekday", () => {
    const rule: RecurrenceRule = {
      _tag: "Weekly",
      weekdays: ["Friday", "Wednesday"],
      time: "18:30",
    };
    expect(nextIso(rule, "2026-11-16T12:00:00Z", "Europe/Warsaw")).toBe(
      "2026-11-18T17:30:00.000Z"
    );
    expect(nextIso(rule, "2026-11-18T17:30:00Z", "Europe/Warsaw")).toBe(
      "2026-11-20T17:30:00.000Z"
    );
    expect(nextIso(rule, "2026-11-20T17:30:00Z", "Europe/Warsaw")).toBe(
      "2026-11-25T17:30:00.000Z"
    );
  });

  it("reads the local weekday, not the UTC weekday", () => {
    expect(
      nextIso(mondayAtNine, "2026-11-15T19:00:00Z", "Pacific/Auckland")
    ).toBe("2026-11-15T20:00:00.000Z");
  });
});

describe("nextOccurrence of a Daily rule", () => {
  const dailyAtHalfPastTwo: RecurrenceRule = { _tag: "Daily", time: "02:30" };

  it("fires at 03:30 local time on the spring-forward day in America/New_York", () => {
    expect(
      nextIso(dailyAtHalfPastTwo, "2026-03-07T12:00:00Z", "America/New_York")
    ).toBe("2026-03-08T07:30:00.000Z");
    expect(
      nextIso(dailyAtHalfPastTwo, "2026-03-08T07:30:00Z", "America/New_York")
    ).toBe("2026-03-09T06:30:00.000Z");
  });

  it("fires once on the fall-back day in America/New_York", () => {
    expect(
      nextIso(dailyAtHalfPastTwo, "2026-10-31T12:00:00Z", "America/New_York")
    ).toBe("2026-11-01T07:30:00.000Z");
    expect(
      nextIso(dailyAtHalfPastTwo, "2026-11-01T07:30:00Z", "America/New_York")
    ).toBe("2026-11-02T07:30:00.000Z");
  });

  it("fires once on the fall-back day for a time that happens twice", () => {
    const rule: RecurrenceRule = { _tag: "Daily", time: "01:30" };
    expect(nextIso(rule, "2026-10-31T12:00:00Z", "America/New_York")).toBe(
      "2026-11-01T06:30:00.000Z"
    );
    expect(nextIso(rule, "2026-11-01T06:30:00Z", "America/New_York")).toBe(
      "2026-11-02T06:30:00.000Z"
    );
  });

  it("fires in the gap day at the first instant after the gap in Europe/Warsaw", () => {
    expect(
      nextIso(dailyAtHalfPastTwo, "2026-03-28T12:00:00Z", "Europe/Warsaw")
    ).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("nextOccurrence of a Monthly rule", () => {
  const warsaw = "Europe/Warsaw";

  it.each([
    ["2027-01-15T12:00:00Z", "2027-01-31T22:00:00.000Z"],
    ["2027-02-01T12:00:00Z", "2027-02-28T22:00:00.000Z"],
    ["2028-02-01T12:00:00Z", "2028-02-29T22:00:00.000Z"],
    ["2027-04-01T12:00:00Z", "2027-04-30T21:00:00.000Z"],
    ["2027-12-01T12:00:00Z", "2027-12-31T22:00:00.000Z"],
  ])("fires on the last day of the month after %s", (after, expected) => {
    expect(
      nextIso({ _tag: "Monthly", day: "last", time: "23:00" }, after, warsaw)
    ).toBe(expected);
  });

  it("moves from the last day of one month to the last day of the next", () => {
    const rule: RecurrenceRule = {
      _tag: "Monthly",
      day: "last",
      time: "09:00",
    };
    expect(nextIso(rule, "2027-01-31T08:00:00Z", warsaw)).toBe(
      "2027-02-28T08:00:00.000Z"
    );
    expect(nextIso(rule, "2027-02-28T08:00:00Z", warsaw)).toBe(
      "2027-03-31T07:00:00.000Z"
    );
  });

  it.each([
    ["2027-04-01T12:00:00Z", "2027-04-30T07:00:00.000Z"],
    ["2027-02-01T12:00:00Z", "2027-02-28T08:00:00.000Z"],
    ["2028-02-01T12:00:00Z", "2028-02-29T08:00:00.000Z"],
    ["2027-05-01T12:00:00Z", "2027-05-31T07:00:00.000Z"],
  ])(
    "fires Monthly 31 on the last day of a shorter month after %s",
    (after, expected) => {
      expect(
        nextIso({ _tag: "Monthly", day: 31, time: "09:00" }, after, warsaw)
      ).toBe(expected);
    }
  );

  it("fires Monthly 15 on the 15th and then in the next month", () => {
    const rule: RecurrenceRule = { _tag: "Monthly", day: 15, time: "09:00" };
    expect(nextIso(rule, "2027-01-10T12:00:00Z", warsaw)).toBe(
      "2027-01-15T08:00:00.000Z"
    );
    expect(nextIso(rule, "2027-01-15T08:00:00Z", warsaw)).toBe(
      "2027-02-15T08:00:00.000Z"
    );
  });

  it("keeps the local time across the daylight saving change", () => {
    const rule: RecurrenceRule = { _tag: "Monthly", day: 28, time: "09:00" };
    expect(nextIso(rule, "2027-02-28T08:00:00Z", warsaw)).toBe(
      "2027-03-28T07:00:00.000Z"
    );
    expect(nextIso(rule, "2027-03-28T07:00:00Z", warsaw)).toBe(
      "2027-04-28T07:00:00.000Z"
    );
  });
});

describe("RecurrenceRuleSchema", () => {
  const decodes = Schema.is(RecurrenceRuleSchema);

  it("accepts the three rules", () => {
    expect(decodes({ _tag: "Daily", time: "08:00" })).toBe(true);
    expect(
      decodes({ _tag: "Weekly", weekdays: ["Monday", "Friday"], time: "09:00" })
    ).toBe(true);
    expect(decodes({ _tag: "Monthly", day: "last", time: "23:59" })).toBe(true);
    expect(decodes({ _tag: "Monthly", day: 1, time: "00:00" })).toBe(true);
  });

  it.each([
    { _tag: "Daily", time: "24:00" },
    { _tag: "Daily", time: "9:00" },
    { _tag: "Daily", time: "09:60" },
    { _tag: "Weekly", weekdays: [], time: "09:00" },
    { _tag: "Weekly", weekdays: ["Monday"], time: "09:00:00" },
    { _tag: "Weekly", weekdays: ["Mon"], time: "09:00" },
    { _tag: "Monthly", day: 0, time: "09:00" },
    { _tag: "Monthly", day: 32, time: "09:00" },
    { _tag: "Monthly", day: 1.5, time: "09:00" },
    { _tag: "Monthly", day: "first", time: "09:00" },
    { _tag: "Yearly", time: "09:00" },
  ])("refuses %j", (rule) => {
    expect(decodes(rule)).toBe(false);
  });
});
