import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import type { JournalRecord } from "../src/journal/journal.ts";
import type { ScheduleFiredEvent } from "../src/personal-agent/inbox.ts";
import { lateNoticeFor } from "../src/personal-agent/reminder-delivery.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";

const dueAt = "2027-01-14T08:00:00.000Z";
const { reminderGraceMillis } = defaultBehaviorConfig;

const event: ScheduleFiredEvent = {
  _tag: "ScheduleFired",
  eventId: "event-1",
  scheduleId: "schedule-1",
  dueAt,
  state: "pending",
};

const handledAfter = (millisAfterDue: number) => {
  const appended: JournalRecord[] = [];
  const services = Layer.mergeAll(
    TestClock.layer(),
    Layer.succeed(
      OwnerPreferences,
      OwnerPreferences.of({
        timeZone: Effect.succeed(Option.some("Europe/Warsaw")),
        setTimeZone: () => Effect.die("not used"),
      })
    ),
    Layer.succeed(
      Journal,
      Journal.of({
        append: (record: JournalRecord) =>
          Effect.sync(() => {
            appended.push(record);
          }),
        read: Effect.succeed([]),
        readForEvent: () => Effect.succeed([]),
      } as never)
    )
  );
  return Effect.gen(function* handledAfterEffect() {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe(dueAt)) + millisAfterDue
    );
    const notice = yield* lateNoticeFor(defaultBehaviorConfig, event);
    return { notice, appended };
  }).pipe(Effect.provide(services), Effect.runPromise);
};

describe("the late notice of a Scheduled Task at the grace boundary", () => {
  it("gives no notice exactly at the end of the grace period", async () => {
    const { notice, appended } = await handledAfter(reminderGraceMillis);
    expect(Option.isNone(notice)).toBe(true);
    expect(appended).toEqual([]);
  });

  it("gives a notice and writes one ReminderLate entry one millisecond later", async () => {
    const { notice, appended } = await handledAfter(reminderGraceMillis + 1);
    expect(Option.isSome(notice)).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      _tag: "ReminderLate",
      lateByMillis: reminderGraceMillis + 1,
    });
  });
});
