import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { instantOfLocalDueTime } from "../src/time/local-due-time.ts";

const instantIn = (zoneName: string, local: string) => {
  const zone = DateTime.zoneMakeNamed(zoneName);
  return Option.isSome(zone)
    ? instantOfLocalDueTime(local, zone.value).pipe(
        Option.map(DateTime.formatIso)
      )
    : Option.none<string>();
};

describe("instantOfLocalDueTime", () => {
  it.each([
    ["Europe/Warsaw", "2026-11-19T09:00", "2026-11-19T08:00:00.000Z"],
    ["Europe/Warsaw", "2026-07-02T09:00", "2026-07-02T07:00:00.000Z"],
    ["America/New_York", "2026-01-15T09:00", "2026-01-15T14:00:00.000Z"],
    ["Europe/Warsaw", "2026-03-29T02:30", "2026-03-29T01:30:00.000Z"],
    ["Europe/Warsaw", "2026-10-25T02:30", "2026-10-25T01:30:00.000Z"],
    ["America/New_York", "2026-03-08T02:30", "2026-03-08T07:30:00.000Z"],
    ["America/New_York", "2026-11-01T01:30", "2026-11-01T06:30:00.000Z"],
    ["Europe/Warsaw", "2028-02-29T09:00", "2028-02-29T08:00:00.000Z"],
  ])(
    "converts %s %s to the later instant of a gap or overlap",
    (zone, local, expected) => {
      expect(instantIn(zone, local)).toEqual(Option.some(expected));
    }
  );

  it.each([
    "2026-02-30T09:00",
    "2027-02-29T09:00",
    "2026-13-01T09:00",
    "2026-11-19T24:00",
    "2026-11-19T09:60",
    "2026-11-19 09:00",
    "2026-11-19T09:00:00",
    "2026-11-19T09:00Z",
    "Thursday",
  ])("refuses %s", (local) => {
    expect(instantIn("Europe/Warsaw", local)).toEqual(Option.none());
  });
});
