import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { endOfQuietHours } from "../src/time/quiet-hours.ts";
import type { QuietHours } from "../src/time/quiet-hours.ts";

const overnight: QuietHours = { start: "22:00", end: "08:00" };
const daytime: QuietHours = { start: "13:00", end: "15:00" };

const endOf = (quietHours: QuietHours, instant: string, zone: string) =>
  endOfQuietHours(
    quietHours,
    DateTime.makeUnsafe(instant),
    DateTime.zoneMakeNamedUnsafe(zone)
  ).pipe(Option.map(DateTime.formatIso), Option.getOrNull);

describe("the end of Quiet Hours", () => {
  it.each([
    {
      name: "before midnight in a range across midnight",
      quietHours: overnight,
      now: "2026-06-10T21:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-06-11T06:00:00.000Z",
    },
    {
      name: "after midnight in a range across midnight",
      quietHours: overnight,
      now: "2026-06-10T23:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-06-11T06:00:00.000Z",
    },
    {
      name: "at the start of a range across midnight",
      quietHours: overnight,
      now: "2026-06-10T20:00:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-06-11T06:00:00.000Z",
    },
    {
      name: "at the end of a range across midnight",
      quietHours: overnight,
      now: "2026-06-11T06:00:00Z",
      zone: "Europe/Warsaw",
      expected: null,
    },
    {
      name: "one minute before the start of a range across midnight",
      quietHours: overnight,
      now: "2026-06-10T19:59:00Z",
      zone: "Europe/Warsaw",
      expected: null,
    },
    {
      name: "inside a range in one day",
      quietHours: daytime,
      now: "2026-06-10T12:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-06-10T13:00:00.000Z",
    },
    {
      name: "outside a range in one day",
      quietHours: daytime,
      now: "2026-06-10T14:00:00Z",
      zone: "Europe/Warsaw",
      expected: null,
    },
    {
      name: "after the March change in Europe/Warsaw",
      quietHours: overnight,
      now: "2026-03-28T22:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-03-29T06:00:00.000Z",
    },
    {
      name: "before the March change in Europe/Warsaw",
      quietHours: overnight,
      now: "2026-03-28T21:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-03-29T06:00:00.000Z",
    },
    {
      name: "across the October change in Europe/Warsaw",
      quietHours: overnight,
      now: "2026-10-24T21:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-10-25T07:00:00.000Z",
    },
    {
      name: "after the October change in Europe/Warsaw",
      quietHours: overnight,
      now: "2026-10-25T02:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-10-25T07:00:00.000Z",
    },
    {
      name: "across the March change in America/New_York",
      quietHours: overnight,
      now: "2026-03-08T04:00:00Z",
      zone: "America/New_York",
      expected: "2026-03-08T12:00:00.000Z",
    },
    {
      name: "the night before the March change in America/New_York",
      quietHours: overnight,
      now: "2026-03-08T03:30:00Z",
      zone: "America/New_York",
      expected: "2026-03-08T12:00:00.000Z",
    },
    {
      name: "across the October change in America/New_York",
      quietHours: overnight,
      now: "2026-11-01T03:30:00Z",
      zone: "America/New_York",
      expected: "2026-11-01T13:00:00.000Z",
    },
    {
      name: "an end that falls in the March gap in Europe/Warsaw",
      quietHours: { start: "22:00", end: "02:30" },
      now: "2026-03-28T22:30:00Z",
      zone: "Europe/Warsaw",
      expected: "2026-03-29T01:30:00.000Z",
    },
  ])("$name", ({ quietHours, now, zone, expected }) => {
    expect(endOf(quietHours, now, zone)).toBe(expected);
  });
});
