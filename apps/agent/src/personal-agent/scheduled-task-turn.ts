import { Clock, DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { Profile } from "../profile/profile.ts";
import { lateScheduledTaskText } from "../schedule/late-reminder.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import { localTimeOf } from "../time/local-time.ts";
import {
  ownerCurrentTimeText,
  ownerTimeZone,
} from "../time/owner-current-time.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { fail, send } from "./delivery.ts";
import { scheduledTaskInputMessage } from "./event-message.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { rememberCompletedSteps } from "./remember-completed-steps.ts";
import { lateNoticeFor } from "./reminder-delivery.ts";
import { scheduledTaskTokensSpentToday } from "./scheduled-task-budget.ts";
import { failScheduledTask } from "./scheduled-task-failure.ts";
import { scheduledTaskSection } from "./scheduled-task-section.ts";
import { skipScheduledTask } from "./scheduled-task-skip.ts";
import { scheduledTaskTools } from "./scheduled-task-tools.ts";
import { systemPrompt } from "./system-prompt.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  recordTurnMetric,
  responseMessagesOf,
  scheduledTaskTraceOf,
  stepLimitReason,
} from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";

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
  const inbox = yield* Inbox;
  const conversation = yield* Conversation;
  const modelGateway = yield* ModelGateway;
  const traces = yield* TurnTraces;
  const redactor = yield* Redactor;
  const notes = yield* Notes;
  const profile = yield* Profile;
  const preferences = yield* OwnerPreferences;
  const progress = yield* TurnProgress;
  const schedules = yield* Schedules;

  const startedAt = yield* Clock.currentTimeMillis;
  const stepsUsed = yield* progress.usedStepCount(event.eventId);
  if (stepsUsed === 0) {
    const tokensSpent = yield* scheduledTaskTokensSpentToday(behavior);
    if (tokensSpent >= behavior.scheduledTaskDailyTokenBudget) {
      yield* skipScheduledTask({
        ownerId,
        event,
        action,
        dailyTokenBudget: behavior.scheduledTaskDailyTokenBudget,
        tokensSpent,
        startedAt,
      });
      return;
    }
  }
  const lateNotice = yield* lateNoticeFor(behavior, event);
  const timeZone = yield* ownerTimeZone(behavior);
  const setAtText =
    timeZone._tag === "Some"
      ? `${localTimeOf(schedule.createdAt, timeZone.value)} (${DateTime.zoneToString(timeZone.value)})`
      : DateTime.formatIso(schedule.createdAt);
  const history = yield* conversation.recent;
  const system = systemPrompt({
    behavior,
    profile: yield* profile.read,
    currentTime: yield* ownerCurrentTimeText(behavior),
    situation: [scheduledTaskSection(setAtText)],
  });
  const input = scheduledTaskInputMessage(action.prompt);
  const savedInput = redactor.redactMessage(input);
  const earlier = yield* progress.completedFor(event.eventId);
  const stepsLeft = behavior.maxToolSteps - stepsUsed;
  if (stepsLeft <= 0) {
    yield* conversation.append(event.eventId, [savedInput, ...earlier]);
    yield* failScheduledTask({
      event,
      action,
      reason: stepLimitReason(behavior.maxToolSteps),
    });
    return;
  }
  const messages = [...history, input, ...earlier];
  const outcome: ModelOutcome = yield* modelGateway
    .generate({
      task: "scheduled_task",
      system,
      messages,
      tools: scheduledTaskTools(event.eventId, {
        notes,
        progress,
        redactor,
        preferences,
        schedules,
        behavior,
      }),
      stepLimit: stepsLeft,
    })
    .pipe(
      Effect.map((reply): ModelOutcome => ({ _tag: "Replied", reply })),
      Effect.catchTags({
        ModelUnavailable: (error) =>
          Effect.succeed<ModelOutcome>({ _tag: "ModelFailed", error }),
        StepLimitReached: (error) =>
          Effect.succeed<ModelOutcome>({ _tag: "ModelFailed", error }),
      })
    );
  const modelLatencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
  yield* traces.record(
    scheduledTaskTraceOf({
      event,
      system,
      messages,
      outcome,
      modelLatencyMillis,
      redactor,
    })
  );

  if (outcome._tag === "ModelFailed") {
    yield* rememberCompletedSteps({
      eventId: event.eventId,
      input: savedInput,
      earlier,
      outcome,
    });
    yield* failScheduledTask({
      event,
      action,
      reason: modelFailureReason(outcome.error, redactor),
    });
    yield* recordTurnMetric({
      ownerId,
      eventId: event.eventId,
      outcome,
      result: "model_failed",
      startedAt,
    });
    return;
  }
  const resultText = redactor.redact(outcome.reply.text);
  const delivery = yield* send(
    event,
    Option.isNone(lateNotice)
      ? resultText
      : lateScheduledTaskText(
          resultText,
          lateNotice.value.dueAt,
          lateNotice.value.timeZone
        )
  );
  if (delivery._tag === "Failed") {
    yield* rememberCompletedSteps({
      eventId: event.eventId,
      input: savedInput,
      earlier,
      outcome,
    });
    yield* fail(event, delivery.reason);
    yield* recordTurnMetric({
      ownerId,
      eventId: event.eventId,
      outcome,
      result: "send_failed",
      startedAt,
    });
    return;
  }
  yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  yield* conversation.append(event.eventId, [
    savedInput,
    ...earlier,
    ...responseMessagesOf(outcome).map((message) =>
      redactor.redactMessage(message)
    ),
  ]);
  yield* inbox.markDone([event]);
  yield* recordTurnMetric({
    ownerId,
    eventId: event.eventId,
    outcome,
    result: "replied",
    startedAt,
  });
});
