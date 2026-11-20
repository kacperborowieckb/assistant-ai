import { DateTime, Effect } from "effect";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";

const localClock = (instant: DateTime.Utc, zone: DateTime.TimeZone) => {
  const { hour, minute } = DateTime.toParts(DateTime.setZone(instant, zone));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

export const quietHoursLaterToday = (timeZone: string) =>
  OwnerPreferences.pipe(
    Effect.flatMap((preferences) => {
      const zone = DateTime.zoneMakeNamedUnsafe(timeZone);
      const now = DateTime.nowUnsafe();
      return preferences.setQuietHours(
        {
          start: localClock(DateTime.add(now, { hours: 2 }), zone),
          end: localClock(DateTime.add(now, { hours: 3 }), zone),
        },
        defaultBehaviorConfig.quietHours,
        "test-setup"
      );
    })
  );
