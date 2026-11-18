import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { Notes } from "../notes/notes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { Profile } from "../profile/profile.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import { failWithNotice } from "./delivery.ts";
import { eventMessage } from "./event-message.ts";
import { fireSchedule } from "./fire-schedule.ts";
import { Inbox } from "./inbox.ts";
import type { OwnerMessageEvent } from "./inbox.ts";
import { runModelTurn } from "./model-turn.ts";
import { ownerMessageTools } from "./owner-message-tools.ts";
import { recoverReminderRecord } from "./reminder-delivery.ts";
import { completeScheduleOfFailedDelivery } from "./scheduled-delivery-recovery.ts";
import { TurnProgress } from "./turn-progress.ts";
import { traceOf } from "./turn-record.ts";
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
    const notes = yield* Notes;
    const profile = yield* Profile;
    const preferences = yield* OwnerPreferences;
    const progress = yield* TurnProgress;
    const schedules = yield* Schedules;
    const redactor = yield* Redactor;

    yield* runModelTurn({
      ownerId,
      behavior,
      kind: {
        task: "reply",
        event,
        input: eventMessage(event),
        tools: {
          ...tools,
          ...ownerMessageTools(event, {
            notes,
            profile,
            progress,
            redactor,
            preferences,
            schedules,
            behavior,
          }),
        },
        traceOf: (model) => traceOf({ event, ...model }),
        whenFailed: (reason) => failWithNotice(event, reason),
      },
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
        yield* completeScheduleOfFailedDelivery(event);
      }
      const outcome = yield* settleFromJournal(ownerId, event);
      if (outcome === "unanswered") {
        yield* event._tag === "ScheduleFired"
          ? fireSchedule(ownerId, behavior, event)
          : answer(ownerId, { behavior, tools }, event);
      }
    }
  });
