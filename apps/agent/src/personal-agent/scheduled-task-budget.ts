import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { UsageLedger } from "../model-gateway/usage-ledger.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { startOfLocalDay } from "../time/start-of-local-day.ts";

export const tokensSpentToday = Effect.fnUntraced(function* tokensSpentToday(
  task: "scheduled_task" | "proactive",
  behavior: Pick<BehaviorConfig, "defaultTimeZone">
) {
  const ledger = yield* UsageLedger;
  const now = yield* DateTime.now;
  const timeZone = (yield* ownerTimeZone(behavior)).pipe(
    Option.getOrElse(() => DateTime.zoneMakeOffset(0))
  );
  return yield* ledger.tokensSpent(task, startOfLocalDay(now, timeZone));
});

export const scheduledTaskTokensSpentToday = (
  behavior: Pick<BehaviorConfig, "defaultTimeZone">
) => tokensSpentToday("scheduled_task", behavior);
