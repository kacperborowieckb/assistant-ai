import { DateTime, Effect } from "effect";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";

const minutesInDay = 24 * 60;

const clockText = (minutes: number) => {
  const wrapped = minutes % minutesInDay;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

export const quietHoursLaterToday = (timeZone: string) =>
  OwnerPreferences.pipe(
    Effect.flatMap((preferences) => {
      const zone = DateTime.zoneMakeNamedUnsafe(timeZone);
      const { hour, minute } = DateTime.toParts(
        DateTime.setZone(DateTime.nowUnsafe(), zone)
      );
      const localMinutes = hour * 60 + minute;
      return preferences.setQuietHours(
        {
          start: clockText(localMinutes + 120),
          end: clockText(localMinutes + 180),
        },
        defaultBehaviorConfig.quietHours,
        "test-setup"
      );
    })
  );
