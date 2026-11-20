import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { scheduledTaskTokensSpentToday } from "../src/personal-agent/scheduled-task-budget.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { startOfLocalDay } from "../src/time/start-of-local-day.ts";

const { scheduledTaskDailyTokenBudget } = defaultBehaviorConfig;

interface SpentTokens {
  readonly recordedAt: number;
  readonly tokens: number;
}

const budgetIsSpentAt = (isoInstant: string, spent: readonly SpentTokens[]) => {
  const services = Layer.mergeAll(
    TestClock.layer(),
    Layer.succeed(
      OwnerPreferences,
      OwnerPreferences.of({
        timeZone: Effect.succeed(Option.some("Europe/Warsaw")),
        setTimeZone: () => Effect.die("not used"),
        quietHours: () => Effect.die("not used"),
        setQuietHours: () => Effect.die("not used"),
        proactiveMutes: Effect.die("not used"),
        changeProactiveMutes: () => Effect.die("not used"),
      })
    ),
    Layer.succeed(UsageLedger, {
      record: () => Effect.die("not used"),
      read: Effect.succeed([]),
      tokensSpent: (_task, since) =>
        Effect.succeed(
          spent
            .filter(
              ({ recordedAt }) => recordedAt >= DateTime.toEpochMillis(since)
            )
            .reduce((total, { tokens }) => total + tokens, 0)
        ),
    })
  );
  return Effect.gen(function* budgetIsSpentEffect() {
    yield* TestClock.setTime(Date.parse(isoInstant));
    const tokensSpent = yield* scheduledTaskTokensSpentToday(
      defaultBehaviorConfig
    );
    return tokensSpent >= scheduledTaskDailyTokenBudget;
  }).pipe(Effect.provide(services), Effect.runPromise);
};

const spentAt = (isoInstant: string): SpentTokens => ({
  recordedAt: Date.parse(isoInstant),
  tokens: scheduledTaskDailyTokenBudget,
});

describe("the daily Token Budget across midnight of the Owner", () => {
  it("stays spent until midnight in the time zone of the Owner", async () => {
    const spent = [spentAt("2027-01-14T10:00:00.000Z")];
    expect(await budgetIsSpentAt("2027-01-14T22:59:59.999Z", spent)).toBe(true);
  });

  it("resets at midnight in the time zone of the Owner, which is 23:00Z in winter", async () => {
    const spent = [spentAt("2027-01-14T10:00:00.000Z")];
    expect(await budgetIsSpentAt("2027-01-14T23:00:00.000Z", spent)).toBe(
      false
    );
  });

  it("does not reset at midnight UTC", async () => {
    const spent = [spentAt("2027-01-14T23:30:00.000Z")];
    expect(await budgetIsSpentAt("2027-01-15T00:30:00.000Z", spent)).toBe(true);
  });

  it("counts again after the reset", async () => {
    const spent = [
      spentAt("2027-01-14T10:00:00.000Z"),
      spentAt("2027-01-15T09:00:00.000Z"),
    ];
    expect(await budgetIsSpentAt("2027-01-15T12:00:00.000Z", spent)).toBe(true);
  });
});

describe("the start of a local day", () => {
  it("follows the offset of the day when daylight saving time starts", () => {
    const zone = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");
    const start = startOfLocalDay(
      DateTime.makeUnsafe("2027-03-28T12:00:00.000Z"),
      zone
    );
    expect(DateTime.formatIso(start)).toBe("2027-03-27T23:00:00.000Z");
  });
});
