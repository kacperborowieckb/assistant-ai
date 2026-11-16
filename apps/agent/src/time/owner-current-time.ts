import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { currentTimeText } from "./local-time.ts";
import { namedTimeZone } from "./time-zone.ts";

export const ownerCurrentTimeText = Effect.fnUntraced(
  function* ownerCurrentTimeText({
    defaultTimeZone,
  }: Pick<BehaviorConfig, "defaultTimeZone">) {
    const preferences = yield* OwnerPreferences;
    const preferred = yield* preferences.timeZone;
    const timeZone = preferred.pipe(
      Option.orElse(() => Option.fromNullishOr(defaultTimeZone)),
      Option.flatMap(namedTimeZone)
    );
    return currentTimeText(yield* DateTime.now, timeZone);
  }
);
