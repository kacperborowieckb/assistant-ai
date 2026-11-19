import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { OwnerId } from "../owner-id.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import { deliveryStateOf, honestFailureText } from "./delivery.ts";
import type { DeliveryState } from "./delivery.ts";
import {
  recordProactiveMessageSent,
  runProactiveMessage,
} from "./fired-proactive.ts";
import { deliverReminder, recoverReminderOutcome } from "./fired-reminder.ts";
import { resumeSkippedScheduledTask } from "./fired-scheduled-task-skip.ts";
import {
  runScheduledTask,
  scheduledTaskFailureText,
} from "./fired-scheduled-task.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { settleFromJournal } from "./turn-recovery.ts";

const hasEndedSending = (state: DeliveryState) =>
  state._tag === "Sent" ||
  state._tag === "SendFailed" ||
  state._tag === "Unconfirmed" ||
  state._tag === "FailedNoticePending" ||
  state._tag === "SendFailureRecorded" ||
  state._tag === "FailedNoticeRefused" ||
  state._tag === "FailedNoticeUnconfirmed";

const completesScheduleAfter = (schedule: Schedule, state: DeliveryState) => {
  const { action } = schedule;
  switch (action._tag) {
    case "SendText": {
      return hasEndedSending(state);
    }
    case "RunPrompt": {
      return schedule.setBy === "agent"
        ? hasEndedSending(state)
        : state._tag === "Sent" || state._tag === "FailedNoticePending";
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
  if (schedule.value.setBy === "agent" && state._tag === "Sent") {
    const proactiveMessages = yield* ProactiveMessages;
    const recorded = yield* proactiveMessages.recordSent(
      event.eventId,
      state.channelMessageId
    );
    if (recorded) {
      yield* recordProactiveMessageSent(ownerId, event.eventId, 0);
    }
  }
  if (completesScheduleAfter(schedule.value, state)) {
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  }
  if (schedule.value.action._tag === "SendText") {
    yield* recoverReminderOutcome(ownerId, event, state);
  }
});

const failureNoticeTextOf = (schedule: Option.Option<Schedule>) => {
  if (Option.isNone(schedule) || schedule.value.action._tag !== "RunPrompt") {
    return Effect.succeed<string | undefined>(honestFailureText);
  }
  return schedule.value.setBy === "agent"
    ? Effect.succeed<string | undefined>(undefined)
    : scheduledTaskFailureText(schedule.value.action.prompt);
};

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
        if (schedule.value.setBy === "agent") {
          return yield* runProactiveMessage({
            ownerId,
            behavior,
            event,
            action,
          });
        }
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
