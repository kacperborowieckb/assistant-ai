import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import { Notes } from "../notes/notes.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { agentSchedulesDueWithinMergeWindow } from "../proactive/merge-window.ts";
import { openLoopsWithMutes } from "../proactive/muted-open-loops.ts";
import { briefScheduleIdOf } from "../schedule/brief.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";

export interface MergedSchedule {
  readonly schedule: Schedule;
  readonly dueAt: string;
}

const isMergeable = Effect.fnUntraced(function* isMergeable(
  candidate: Schedule
) {
  if (candidate.action._tag !== "RunPrompt") {
    return false;
  }
  const { open, muted } = yield* openLoopsWithMutes(
    { preferences: yield* OwnerPreferences, notes: yield* Notes },
    candidate.openLoopIds
  );
  return open.length === 0 || muted.length < open.length;
});

const candidatesFor = Effect.fnUntraced(function* candidatesFor(
  behavior: Pick<BehaviorConfig, "proactiveMergeWindowMillis">,
  lead: Schedule
) {
  const briefId = yield* briefScheduleIdOf({
    schedules: yield* Schedules,
    journal: yield* Journal,
  });
  const due = yield* agentSchedulesDueWithinMergeWindow(behavior);
  const others = due.filter(
    ({ scheduleId }) =>
      scheduleId !== lead.scheduleId && !Option.contains(briefId, scheduleId)
  );
  const verdicts = yield* Effect.all(others.map((other) => isMergeable(other)));
  const mergeable = others.filter((_, index) => verdicts[index]);
  return mergeable.map((schedule): MergedSchedule => ({
    schedule,
    dueAt: DateTime.formatIso(schedule.nextDueAt),
  }));
});

const recordedMerge = Effect.fnUntraced(function* recordedMerge(
  eventId: string
) {
  const journal = yield* Journal;
  const entries = yield* journal.readForEvent(eventId);
  const merged = entries.find(
    ({ record }) => record._tag === "ProactiveMessageMerged"
  );
  return {
    wasPlanned: entries.some(
      ({ record }) => record._tag === "ProactiveMessagePlanned"
    ),
    merged:
      merged?.record._tag === "ProactiveMessageMerged"
        ? merged.record.merged
        : undefined,
  };
});

const isStillDue = ({ schedule, dueAt }: MergedSchedule) =>
  schedule.state === "active" &&
  DateTime.formatIso(schedule.nextDueAt) === dueAt;

const loadRecorded = Effect.fnUntraced(function* loadRecorded(
  recorded: readonly { readonly scheduleId: string; readonly dueAt: string }[]
) {
  const schedules = yield* Schedules;
  const loaded = yield* Effect.all(
    recorded.map(({ scheduleId, dueAt }) =>
      schedules
        .byId(scheduleId)
        .pipe(
          Effect.map(
            Option.map((schedule): MergedSchedule => ({ schedule, dueAt }))
          )
        )
    )
  );
  return loaded.flatMap((merged) =>
    Option.isSome(merged) && isStillDue(merged.value) ? [merged.value] : []
  );
});

export const mergedSchedulesFor = Effect.fnUntraced(
  function* mergedSchedulesFor(
    behavior: Pick<BehaviorConfig, "proactiveMergeWindowMillis">,
    event: ScheduleFiredEvent,
    lead: Schedule
  ) {
    const { wasPlanned, merged } = yield* recordedMerge(event.eventId);
    if (merged !== undefined) {
      return yield* loadRecorded(merged);
    }
    if (wasPlanned) {
      return [];
    }
    const candidates = yield* candidatesFor(behavior, lead);
    if (candidates.length > 0) {
      const journal = yield* Journal;
      yield* journal.append({
        _tag: "ProactiveMessageMerged",
        eventId: event.eventId,
        merged: candidates.map(({ schedule, dueAt }) => ({
          scheduleId: schedule.scheduleId,
          dueAt,
        })),
      });
    }
    return candidates;
  }
);

export const completeMergedSchedules = Effect.fnUntraced(
  function* completeMergedSchedules(eventId: string) {
    const schedules = yield* Schedules;
    const { merged } = yield* recordedMerge(eventId);
    for (const { scheduleId, dueAt } of merged ?? []) {
      yield* schedules.complete(scheduleId, dueAt, eventId);
    }
  }
);
