import { DateTime } from "effect";
import { describe, expect, it } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import {
  isLate,
  lateByMillisOf,
  lateReminderText,
  lateScheduledTaskText,
} from "../src/schedule/lateness.ts";

const due = DateTime.makeUnsafe("2027-01-14T08:00:00Z");
const { reminderGraceMillis } = defaultBehaviorConfig;

const handledAfter = (millis: number) =>
  isLate(
    lateByMillisOf(DateTime.addDuration(due, millis), due),
    reminderGraceMillis
  );

describe("the grace period of a Reminder", () => {
  it("counts a Reminder handled before, or exactly at, the end of the grace period as on time", () => {
    expect(handledAfter(0)).toBe(false);
    expect(handledAfter(reminderGraceMillis - 1)).toBe(false);
    expect(handledAfter(reminderGraceMillis)).toBe(false);
  });

  it("counts a Reminder handled one millisecond after the grace period as late", () => {
    expect(handledAfter(reminderGraceMillis + 1)).toBe(true);
  });

  it("gives the due time in the local time of the Owner", () => {
    expect(
      lateReminderText(
        "Buy the gift",
        due,
        DateTime.zoneMakeNamedUnsafe("Europe/Warsaw")
      )
    ).toBe(
      "This Reminder is late. It was due Thursday 2027-01-14, 09:00 (Europe/Warsaw): Buy the gift"
    );
  });

  it("names a late Scheduled Task and gives the local due time", () => {
    expect(
      lateScheduledTaskText(
        "Your tasks",
        due,
        DateTime.zoneMakeNamedUnsafe("Europe/Warsaw")
      )
    ).toBe(
      "This Scheduled Task is late. It was due Thursday 2027-01-14, 09:00 (Europe/Warsaw): Your tasks"
    );
  });
});
