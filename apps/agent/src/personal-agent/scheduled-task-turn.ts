import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { Profile } from "../profile/profile.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import { ScheduleAlarm } from "../schedule/schedule-alarm.ts";
import { Schedules } from "../schedule/schedules.ts";
import { ownerCurrentTimeText } from "../time/owner-current-time.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { scheduledTaskInputMessage } from "./event-message.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { rememberCompletedSteps } from "./remember-completed-steps.ts";
import { scheduledTaskSection } from "./scheduled-task-section.ts";
import { scheduledTaskTools } from "./scheduled-task-tools.ts";
import { systemPrompt } from "./system-prompt.ts";
import {
  deliver,
  failTurnWithHonestMessage,
  recordTurnFailed,
} from "./turn-delivery.ts";
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
  readonly action: RunPrompt;
}

export const runScheduledTask = Effect.fnUntraced(function* runScheduledTask({
  ownerId,
  behavior,
  event,
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
  const alarm = yield* ScheduleAlarm;

  const startedAt = yield* Clock.currentTimeMillis;
  const history = yield* conversation.recent;
  const system = systemPrompt({
    behavior,
    profile: yield* profile.read,
    currentTime: yield* ownerCurrentTimeText(behavior),
    situation: [scheduledTaskSection],
  });
  const input = scheduledTaskInputMessage(action.prompt);
  const earlier = yield* progress.completedFor(event.eventId);
  const stepsLeft =
    behavior.maxToolSteps - (yield* progress.usedStepCount(event.eventId));
  if (stepsLeft <= 0) {
    yield* conversation.append(event.eventId, [input, ...earlier]);
    yield* failTurnWithHonestMessage(
      event,
      stepLimitReason(behavior.maxToolSteps)
    );
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
        alarm,
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
      input,
      earlier,
      outcome,
    });
    yield* failTurnWithHonestMessage(
      event,
      modelFailureReason(outcome.error, redactor)
    );
    yield* recordTurnMetric({
      ownerId,
      outcome,
      result: "model_failed",
      startedAt,
    });
    return;
  }
  const delivery = yield* deliver(event, redactor.redact(outcome.reply.text));
  if (delivery._tag === "Failed") {
    yield* rememberCompletedSteps({
      eventId: event.eventId,
      input,
      earlier,
      outcome,
    });
    yield* recordTurnFailed(event, delivery.reason);
    yield* recordTurnMetric({
      ownerId,
      outcome,
      result: "send_failed",
      startedAt,
    });
    return;
  }
  yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  yield* conversation.append(event.eventId, [
    redactor.redactMessage(input),
    ...earlier,
    ...responseMessagesOf(outcome).map((message) =>
      redactor.redactMessage(message)
    ),
  ]);
  yield* inbox.markDone([event]);
  yield* recordTurnMetric({ ownerId, outcome, result: "replied", startedAt });
});
