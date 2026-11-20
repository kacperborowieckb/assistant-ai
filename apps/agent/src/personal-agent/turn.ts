import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { OwnerId } from "../owner-id.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import { connectedProactivePreparation } from "./connected-proactive-section.ts";
import { failWithNotice } from "./delivery.ts";
import { eventMessage } from "./event-message.ts";
import { handleFiredSchedule } from "./fired-schedule.ts";
import { Inbox } from "./inbox.ts";
import type { OwnerMessageEvent } from "./inbox.ts";
import { runModelTurn } from "./model-turn.ts";
import {
  recordOutcomeOfConnectedTurn,
  recordOutcomesOfFinishedTurns,
} from "./outcome-records.ts";
import { ownerMessageTools } from "./owner-message-tools.ts";
import { traceOf } from "./turn-record.ts";
import { ownerMessageRecovery, settleFromJournal } from "./turn-recovery.ts";

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
    const toolServices = yield* agentToolServices;
    const preparation = yield* connectedProactivePreparation(behavior, event);

    yield* runModelTurn({
      ownerId,
      behavior,
      kind: {
        task: "reply",
        event,
        input: eventMessage(event),
        tools: {
          ...tools,
          ...ownerMessageTools(event, { ...toolServices, behavior }),
        },
        prepare: Effect.succeed(preparation),
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
    yield* recordOutcomesOfFinishedTurns(ownerId);
    const events = yield* inbox.pending;
    for (const event of events) {
      if (event._tag === "ScheduleFired") {
        yield* handleFiredSchedule(ownerId, behavior, event);
        continue;
      }
      const outcome = yield* settleFromJournal(event, ownerMessageRecovery);
      if (outcome === "unanswered") {
        yield* answer(ownerId, { behavior, tools }, event);
      }
      yield* recordOutcomeOfConnectedTurn(ownerId, event.eventId);
    }
  });
