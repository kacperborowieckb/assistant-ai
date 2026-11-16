import type { ModelMessage } from "ai";
import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { NoteToolServices } from "../notes/note-tool-services.ts";
import { noteToolsFor } from "../notes/note-tools.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import {
  setTimeZoneTool,
  setTimeZoneToolName,
} from "../preferences/set-time-zone-tool.ts";
import { Profile } from "../profile/profile.ts";
import {
  updateProfileTool,
  updateProfileToolName,
} from "../profile/update-profile-tool.ts";
import { ownerCurrentTimeText } from "../time/owner-current-time.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { eventMessage } from "./event-message.ts";
import { trustLevelOfEvent } from "./event-trust.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent, OwnerMessageEvent } from "./inbox.ts";
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
  toolMessagesOf,
  recordTurnMetric,
  traceOf,
} from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";
import { settleFromJournal } from "./turn-recovery.ts";

const rememberCompletedSteps = (
  event: InboxEvent,
  earlier: readonly ModelMessage[],
  outcome: ModelOutcome
) =>
  Effect.gen(function* rememberCompletedStepsEffect() {
    const conversation = yield* Conversation;
    const redactor = yield* Redactor;
    const completed = toolMessagesOf(outcome);

    if (earlier.length + completed.length > 0) {
      yield* conversation.append(event.eventId, [
        eventMessage(event),
        ...earlier,
        ...completed.map((message) => redactor.redactMessage(message)),
      ]);
    }
  });

interface TurnSettings {
  readonly behavior: BehaviorConfig;
  readonly tools: AgentTools;
}

interface OwnerMessageToolServices extends NoteToolServices {
  readonly profile: Profile["Service"];
  readonly maxProfileCharacters: number;
}

const ownerMessageTools = (
  event: OwnerMessageEvent,
  { profile, maxProfileCharacters, ...noteServices }: OwnerMessageToolServices
) => ({
  ...noteToolsFor(noteServices, event),
  ...(trustLevelOfEvent(event) === "owner"
    ? {
        [updateProfileToolName]: updateProfileTool(
          {
            profile,
            progress: noteServices.progress,
            redactor: noteServices.redactor,
            characterLimit: maxProfileCharacters,
          },
          event.eventId
        ),
      }
    : {}),
});

const answer = (
  ownerId: OwnerId,
  { behavior, tools }: TurnSettings,
  event: InboxEvent
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

    const startedAt = yield* Clock.currentTimeMillis;
    const history = yield* conversation.recent;
    const system = systemPrompt(
      behavior,
      yield* profile.read,
      yield* ownerCurrentTimeText(behavior)
    );
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
          ...(event._tag === "OwnerMessage"
            ? ownerMessageTools(event, {
                notes,
                profile,
                progress,
                redactor,
                maxProfileCharacters: behavior.maxProfileCharacters,
              })
            : {}),
          ...(trustLevelOfEvent(event) === "owner"
            ? {
                [setTimeZoneToolName]: setTimeZoneTool(
                  { preferences, progress, redactor },
                  event.eventId
                ),
              }
            : {}),
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
      yield* rememberCompletedSteps(event, earlier, outcome);
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
    const replyText = redactor.redact(outcome.reply.text);
    const delivery = yield* deliver(event, replyText);
    if (delivery._tag === "Failed") {
      yield* rememberCompletedSteps(event, earlier, outcome);
      yield* recordTurnFailed(event, delivery.reason);
      yield* recordTurnMetric({
        ownerId,
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
    yield* recordTurnMetric({ ownerId, outcome, result: "replied", startedAt });
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
      const outcome = yield* settleFromJournal(event);
      if (outcome === "unanswered") {
        yield* answer(ownerId, { behavior, tools }, event);
      }
    }
  });
