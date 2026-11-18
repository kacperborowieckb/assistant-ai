import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { OwnerId } from "../owner-id.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import { deliveryStateOf, honestFailureText } from "./delivery.ts";
import type { DeliveryState } from "./delivery.ts";
import { deliverReminder, recoverReminderOutcome } from "./fired-reminder.ts";
import { resumeSkippedScheduledTask } from "./fired-scheduled-task-skip.ts";
import {
  runScheduledTask,
  scheduledTaskFailureText,
} from "./fired-scheduled-task.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { settleFromJournal } from "./turn-recovery.ts";

const completesScheduleAfter = (
  action: Schedule["action"],
  state: DeliveryState
) => {
  switch (action._tag) {
    case "SendText": {
      return (
        state._tag === "Sent" ||
        state._tag === "SendFailed" ||
        state._tag === "Unconfirmed" ||
        state._tag === "FailedNoticePending" ||
        state._tag === "SendFailureRecorded" ||
        state._tag === "FailedNoticeRefused" ||
        state._tag === "FailedNoticeUnconfirmed"
      );
    }
    case "RunPrompt": {
      return state._tag === "Sent" || state._tag === "FailedNoticePending";
    }
    default: {
      return action satisfies never;
    }
  }
};

const isStillDue = (schedule: Schedule, event: ScheduleFiredEvent) =>
  schedule.state === "active" &&
  DateTime.formatIso(schedule.nextDueAt) === event.dueAt;

const recover = Effect.fnUntraced(function* recover(
  ownerId: OwnerId,
  event: ScheduleFiredEvent,
  schedule: Option.Option<Schedule>
) {
  const schedules = yield* Schedules;
  const state = yield* deliveryStateOf(event.eventId);
  if (Option.isNone(schedule)) {
    return;
  }
  if (completesScheduleAfter(schedule.value.action, state)) {
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  }
  if (schedule.value.action._tag === "SendText") {
    yield* recoverReminderOutcome(ownerId, event, state);
  }
});

const failureNoticeTextOf = (schedule: Option.Option<Schedule>) =>
  Option.isSome(schedule) && schedule.value.action._tag === "RunPrompt"
    ? scheduledTaskFailureText(schedule.value.action.prompt)
    : Effect.succeed(honestFailureText);

const resumeUnsentFor = (
  ownerId: OwnerId,
  event: ScheduleFiredEvent,
  schedule: Option.Option<Schedule>
) =>
  Effect.fnUntraced(function* resumeSkipped(
    skipped:
      | { readonly dailyTokenBudget: number; readonly tokensSpent: number }
      | undefined
  ) {
    if (skipped === undefined) {
      return "unanswered" as const;
    }
    if (Option.isSome(schedule) && schedule.value.action._tag === "RunPrompt") {
      yield* resumeSkippedScheduledTask(
        { ownerId, event, action: schedule.value.action },
        skipped
      );
    }
    return "settled" as const;
  });

export const handleFiredSchedule = Effect.fnUntraced(
  function* handleFiredSchedule(
    ownerId: OwnerId,
    behavior: BehaviorConfig,
    event: ScheduleFiredEvent
  ) {
    const inbox = yield* Inbox;
    const schedules = yield* Schedules;
    const schedule = yield* schedules.byId(event.scheduleId);

    yield* recover(ownerId, event, schedule);
    const outcome = yield* settleFromJournal(event, {
      resumeUnsent: resumeUnsentFor(ownerId, event, schedule),
      failureNoticeText: failureNoticeTextOf(schedule),
    });
    if (outcome === "settled") {
      return;
    }
    if (Option.isNone(schedule) || !isStillDue(schedule.value, event)) {
      yield* inbox.markDone([event]);
      return;
    }
    const { action } = schedule.value;
    switch (action._tag) {
      case "SendText": {
        return yield* deliverReminder({ ownerId, behavior, event, action });
      }
      case "RunPrompt": {
        return yield* runScheduledTask({
          ownerId,
          behavior,
          event,
          schedule: schedule.value,
          action,
        });
      }
      default: {
        return action satisfies never;
      }
    }
  }
);
