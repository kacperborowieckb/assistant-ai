import type { DateTime, Effect, Option } from "effect";

import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { MutedLookupFailed } from "../proactive/muted-open-loops.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { Schedules } from "./schedules.ts";

export interface ScheduleToolServices {
  readonly schedules: Schedules["Service"];
  readonly ownerTimeZone: Effect.Effect<Option.Option<DateTime.TimeZone.Named>>;
  readonly mutedAmong: (
    noteIds: readonly string[]
  ) => Effect.Effect<readonly string[], MutedLookupFailed>;
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
  readonly maxActiveScheduledTasks: number;
  readonly maxActiveAgentSchedules: number;
  readonly turnOrigin: "owner-message" | "proactive";
}
