import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import { Notes } from "../notes/notes.ts";
import { tokensSpentToday } from "../personal-agent/scheduled-task-budget.ts";
import type {
  proactiveFoldReasons,
  proactiveHoldReasons,
} from "../personal-agent/storage-values.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { briefScheduleIdOf } from "../schedule/brief.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { endOfQuietHours } from "../time/quiet-hours.ts";
import { startOfLocalDay } from "../time/start-of-local-day.ts";
import { openLoopsWithMutes } from "./muted-open-loops.ts";
import { ProactiveMessages } from "./proactive-messages.ts";

export const openLoopsInFold = 20;

export type ProactiveGateDecision =
  | { readonly _tag: "Send" }
  | {
      readonly _tag: "FoldIntoBrief";
      readonly openLoopIds: readonly string[];
      readonly reason: (typeof proactiveFoldReasons)[number];
      readonly budget?: number;
      readonly used?: number;
    }
  | {
      readonly _tag: "Hold";
      readonly until: DateTime.Utc;
      readonly reason: (typeof proactiveHoldReasons)[number];
    };

type GateBehavior = Pick<
  BehaviorConfig,
  | "defaultTimeZone"
  | "quietHours"
  | "proactiveMessageBudget"
  | "proactiveDailyTokenBudget"
>;

type GatedSchedule = Pick<Schedule, "openLoopIds" | "scheduleId">;

interface BudgetUse {
  readonly sends: number;
  readonly sentToday: number;
  readonly tokenBudget: number;
  readonly tokensSpent: number;
}

const budgetExceeded = ({
  sends,
  sentToday,
  tokenBudget,
  tokensSpent,
}: BudgetUse) => {
  if (sentToday >= sends) {
    return {
      reason: "message_budget",
      budget: sends,
      used: sentToday,
    } as const;
  }
  return tokensSpent >= tokenBudget
    ? ({
        reason: "token_budget",
        budget: tokenBudget,
        used: tokensSpent,
      } as const)
    : undefined;
};

const budgetFold = Effect.fnUntraced(function* budgetFold(
  behavior: GateBehavior,
  schedule: GatedSchedule,
  timeZone: Option.Option<DateTime.TimeZone>
) {
  const preferences = yield* OwnerPreferences;
  const proactiveMessages = yield* ProactiveMessages;
  const { sends } = yield* preferences.proactiveMessageBudget(
    behavior.proactiveMessageBudget
  );
  const dayStart = startOfLocalDay(
    yield* DateTime.now,
    Option.getOrElse(timeZone, () => DateTime.zoneMakeOffset(0))
  );
  const sentToday = yield* proactiveMessages.sentSince(dayStart);
  const tokensSpent = yield* tokensSpentToday("proactive", behavior);
  const exceeded = budgetExceeded({
    sends,
    sentToday,
    tokenBudget: behavior.proactiveDailyTokenBudget,
    tokensSpent,
  });
  if (exceeded === undefined) {
    return Option.none<ProactiveGateDecision>();
  }
  const notes = yield* Notes;
  const openLoops =
    schedule.openLoopIds.length > 0
      ? yield* notes.openLoopsAmong(schedule.openLoopIds)
      : (yield* notes.listOpenLoops({ offset: 0, limit: openLoopsInFold }))
          .notes;
  return Option.some({
    _tag: "FoldIntoBrief",
    openLoopIds: openLoops.map(({ noteId }) => noteId),
    ...exceeded,
  } satisfies ProactiveGateDecision);
});

export const decideProactiveMessage = Effect.fnUntraced(
  function* decideProactiveMessage(
    behavior: GateBehavior,
    schedule: GatedSchedule
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
    if (Option.isSome(timeZone)) {
      const { quietHours } = yield* preferences.quietHours(behavior.quietHours);
      const until = endOfQuietHours(
        quietHours,
        yield* DateTime.now,
        timeZone.value
      );
      if (Option.isSome(until)) {
        return {
          _tag: "Hold",
          until: until.value,
          reason: "quiet_hours",
        } satisfies ProactiveGateDecision;
      }
    }
    const briefId = yield* briefScheduleIdOf({
      schedules: yield* Schedules,
      journal: yield* Journal,
    });
    if (Option.contains(briefId, schedule.scheduleId)) {
      return { _tag: "Send" } satisfies ProactiveGateDecision;
    }
    const fold = yield* budgetFold(behavior, schedule, timeZone);
    return Option.isSome(fold)
      ? fold.value
      : ({ _tag: "Send" } satisfies ProactiveGateDecision);
  }
);
