import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { proactiveHoldReasons } from "../personal-agent/storage-values.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { endOfQuietHours } from "../time/quiet-hours.ts";

export type ProactiveGateDecision =
  | { readonly _tag: "Send" }
  | {
      readonly _tag: "Hold";
      readonly until: DateTime.Utc;
      readonly reason: (typeof proactiveHoldReasons)[number];
    };

export const decideProactiveMessage = Effect.fnUntraced(
  function* decideProactiveMessage(
    behavior: Pick<BehaviorConfig, "defaultTimeZone" | "quietHours">
  ) {
    const preferences = yield* OwnerPreferences;
    const timeZone = yield* ownerTimeZone(behavior);
    if (Option.isNone(timeZone)) {
      return { _tag: "Send" } satisfies ProactiveGateDecision;
    }
    const { quietHours } = yield* preferences.quietHours(behavior.quietHours);
    const until = endOfQuietHours(
      quietHours,
      yield* DateTime.now,
      timeZone.value
    );
    return Option.isSome(until)
      ? ({
          _tag: "Hold",
          until: until.value,
          reason: "quiet_hours",
        } satisfies ProactiveGateDecision)
      : ({ _tag: "Send" } satisfies ProactiveGateDecision);
  }
);
