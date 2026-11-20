import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Notes } from "../notes/notes.ts";
import type {
  proactiveFoldReasons,
  proactiveHoldReasons,
} from "../personal-agent/storage-values.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { endOfQuietHours } from "../time/quiet-hours.ts";
import { openLoopsWithMutes } from "./muted-open-loops.ts";

export type ProactiveGateDecision =
  | { readonly _tag: "Send" }
  | {
      readonly _tag: "FoldIntoBrief";
      readonly openLoopIds: readonly string[];
      readonly reason: (typeof proactiveFoldReasons)[number];
    }
  | {
      readonly _tag: "Hold";
      readonly until: DateTime.Utc;
      readonly reason: (typeof proactiveHoldReasons)[number];
    };

export const decideProactiveMessage = Effect.fnUntraced(
  function* decideProactiveMessage(
    behavior: Pick<BehaviorConfig, "defaultTimeZone" | "quietHours">,
    schedule: Pick<Schedule, "openLoopIds">
  ) {
    const preferences = yield* OwnerPreferences;
    const notes = yield* Notes;
    const { open, muted } = yield* openLoopsWithMutes(
      { preferences, notes },
      schedule.openLoopIds
    );
    if (open.length > 0 && muted.length === open.length) {
      return {
        _tag: "FoldIntoBrief",
        openLoopIds: open.map(({ noteId }) => noteId),
        reason: "muted",
      } satisfies ProactiveGateDecision;
    }
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
