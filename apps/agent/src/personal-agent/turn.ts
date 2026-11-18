import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { Profile } from "../profile/profile.ts";
import { ScheduleAlarm } from "../schedule/schedule-alarm.ts";
import { Schedules } from "../schedule/schedules.ts";
import { ownerCurrentTimeText } from "../time/owner-current-time.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { eventMessage } from "./event-message.ts";
import { fireSchedule } from "./fire-schedule.ts";
import { Inbox } from "./inbox.ts";
import type { OwnerMessageEvent } from "./inbox.ts";
import { ownerMessageTools } from "./owner-message-tools.ts";
import { rememberCompletedSteps } from "./remember-completed-steps.ts";
import { recoverReminderRecord } from "./reminder-delivery.ts";
import { completeScheduleOfFailedReminder } from "./reminder-failure.ts";
import { completeScheduleOfUnsentFailure } from "./scheduled-task-failure.ts";
import { systemPrompt } from "./system-prompt.ts";
import {
  deliver,
  failTurnWithHonestMessage,
  recordTurnFailed,
} from "./turn-delivery.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  stepLimitReason,
  responseMessagesOf,
  recordTurnMetric,
  traceOf,
} from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";
import { settleFromJournal } from "./turn-recovery.ts";

interface TurnSettings {
  readonly behavior: BehaviorConfig;
  readonly tools: AgentTools;
}

const answer = (
  ownerId: OwnerId,
  { behavior, tools }: TurnSettings,
  event: OwnerMessageEvent
) =>
  Effect.gen(function* answerEffect() {
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
    });
    const earlier = yield* progress.completedFor(event.eventId);
    const stepsLeft =
      behavior.maxToolSteps - (yield* progress.usedStepCount(event.eventId));
    if (stepsLeft <= 0) {
      yield* conversation.append(event.eventId, [
        eventMessage(event),
        ...earlier,
      ]);
      yield* failTurnWithHonestMessage(
        event,
        stepLimitReason(behavior.maxToolSteps)
      );
      return;
    }
    const messages = [...history, eventMessage(event), ...earlier];
    const outcome: ModelOutcome = yield* modelGateway
      .generate({
        task: "reply",
        system,
        messages,
        tools: {
          ...tools,
          ...ownerMessageTools(event, {
            notes,
            profile,
            progress,
            redactor,
            preferences,
            schedules,
            alarm,
            behavior,
          }),
        },
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
      traceOf({
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
        input: eventMessage(event),
        earlier,
        outcome,
      });
      yield* failTurnWithHonestMessage(
        event,
        modelFailureReason(outcome.error, redactor)
      );
      yield* recordTurnMetric({
        ownerId,
        eventId: event.eventId,
        outcome,
        result: "model_failed",
        startedAt,
      });
      return;
    }
    const replyText = redactor.redact(outcome.reply.text);
    const delivery = yield* deliver(event, replyText);
    if (delivery._tag === "Failed") {
      yield* rememberCompletedSteps({
        eventId: event.eventId,
        input: eventMessage(event),
        earlier,
        outcome,
      });
      yield* recordTurnFailed(event, delivery.reason);
      yield* recordTurnMetric({
        ownerId,
        eventId: event.eventId,
        outcome,
        result: "send_failed",
        startedAt,
      });
      return;
    }
    yield* conversation.append(event.eventId, [
      eventMessage(event),
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

export const takeTurn = (
  ownerId: OwnerId,
  behavior: BehaviorConfig,
  tools: AgentTools = noTools
) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const events = yield* inbox.pending;
    for (const event of events) {
      if (event._tag === "ScheduleFired") {
        yield* recoverReminderRecord(ownerId, event);
        yield* completeScheduleOfUnsentFailure(event);
        yield* completeScheduleOfFailedReminder(event);
      }
      const outcome = yield* settleFromJournal(ownerId, event);
      if (outcome === "unanswered") {
        yield* event._tag === "ScheduleFired"
          ? fireSchedule(ownerId, behavior, event)
          : answer(ownerId, { behavior, tools }, event);
      }
    }
  });
