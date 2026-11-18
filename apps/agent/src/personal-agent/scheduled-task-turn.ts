import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { lateScheduledTaskText } from "../schedule/late-reminder.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import { localTimeOf } from "../time/local-time.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { Redactor } from "../tracing/redactor.ts";
import { scheduledTaskInputMessage } from "./event-message.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { runModelTurn } from "./model-turn.ts";
import { lateNoticeFor } from "./reminder-delivery.ts";
import { failScheduledTask } from "./scheduled-task-failure.ts";
import { scheduledTaskSection } from "./scheduled-task-section.ts";
import { skipScheduledTaskOverBudget } from "./scheduled-task-skip.ts";
import { scheduledTaskTools } from "./scheduled-task-tools.ts";
import { TurnProgress } from "./turn-progress.ts";
import { scheduledTaskTraceOf } from "./turn-record.ts";

interface ScheduledTaskRun {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly event: ScheduleFiredEvent;
  readonly schedule: Schedule;
  readonly action: RunPrompt;
}

export const runScheduledTask = Effect.fnUntraced(function* runScheduledTask({
  ownerId,
  behavior,
  event,
  schedule,
  action,
}: ScheduledTaskRun) {
  const notes = yield* Notes;
  const preferences = yield* OwnerPreferences;
  const progress = yield* TurnProgress;
  const schedules = yield* Schedules;
  const redactor = yield* Redactor;

  const lateNotice = yield* lateNoticeFor(behavior, event);
  const timeZone = yield* ownerTimeZone(behavior);
  const setAtText =
    timeZone._tag === "Some"
      ? `${localTimeOf(schedule.createdAt, timeZone.value)} (${DateTime.zoneToString(timeZone.value)})`
      : DateTime.formatIso(schedule.createdAt);
  yield* runModelTurn({
    ownerId,
    behavior,
    kind: {
      task: "scheduled_task",
      event,
      input: scheduledTaskInputMessage(action.prompt),
      tools: scheduledTaskTools(event.eventId, {
        notes,
        progress,
        redactor,
        preferences,
        schedules,
        behavior,
      }),
      situation: [scheduledTaskSection(setAtText)],
      traceOf: (model) => scheduledTaskTraceOf({ event, ...model }),
      checkBeforeFirstStep: (startedAt) =>
        skipScheduledTaskOverBudget({
          ownerId,
          behavior,
          event,
          action,
          startedAt,
        }),
      lateText: (text) =>
        Option.isNone(lateNotice)
          ? text
          : lateScheduledTaskText(
              text,
              lateNotice.value.dueAt,
              lateNotice.value.timeZone
            ),
      whenSent: schedules.complete(
        event.scheduleId,
        event.dueAt,
        event.eventId
      ),
      whenFailed: (reason) => failScheduledTask({ event, action, reason }),
    },
  });
});
