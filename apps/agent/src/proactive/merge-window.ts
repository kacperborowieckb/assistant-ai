import { DateTime, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Schedules } from "../schedule/schedules.ts";

export const agentSchedulesDueWithinMergeWindow = Effect.fnUntraced(
  function* agentSchedulesDueWithinMergeWindow(
    behavior: Pick<BehaviorConfig, "proactiveMergeWindowMillis">
  ) {
    const schedules = yield* Schedules;
    return yield* schedules.activeAgentDueBy(
      DateTime.add(yield* DateTime.now, {
        milliseconds: behavior.proactiveMergeWindowMillis,
      })
    );
  }
);
