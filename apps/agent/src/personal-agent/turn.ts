import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { OwnerId } from "../owner-id.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import type { RecordedOutcome } from "../proactive/proactive-outcomes.ts";
import { Schedules } from "../schedule/schedules.ts";
import { whileAcknowledging } from "./acknowledge.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import { burstWaitOf } from "./burst-wait.ts";
import {
  burstInputs,
  linkBurst,
  newestEventOf,
  pendingBursts,
  settleBurst,
  turnEventOf,
} from "./burst.ts";
import type { Burst } from "./burst.ts";
import { connectedProactivePreparation } from "./connected-proactive-section.ts";
import { failWithNotice } from "./delivery.ts";
import { handleFiredSchedule } from "./fired-schedule.ts";
import { Inbox } from "./inbox.ts";
import { runModelTurn } from "./model-turn.ts";
import {
  recordOutcomeMetric,
  recordOutcomeOfConnectedTurn,
  recordOutcomesOfFinishedTurns,
} from "./outcome-records.ts";
import { ownerMessageTools } from "./owner-message-tools.ts";
import { staySilentSection, staySilentToolName } from "./stay-silent-tool.ts";
import { traceOf } from "./turn-record.ts";
import { ownerMessageRecovery, settleFromJournal } from "./turn-recovery.ts";

interface TurnSettings {
  readonly behavior: BehaviorConfig;
  readonly tools: AgentTools;
}

const settleSilentBurst = (burst: Burst, recorded: RecordedOutcome[]) =>
  Effect.gen(function* settleSilentBurstEffect() {
    const inbox = yield* Inbox;
    const proactiveMessages = yield* ProactiveMessages;
    yield* inbox.markDone(burst.slice(1));
    for (const event of burst) {
      const outcome = yield* proactiveMessages.recordOutcomeOfConnectedTurn(
        event.eventId
      );
      if (Option.isSome(outcome)) {
        recorded.push(outcome.value);
      }
    }
  });

const answer = (
  ownerId: OwnerId,
  { behavior, tools }: TurnSettings,
  burst: Burst
) => {
  const event = turnEventOf(burst);
  const replyTo = newestEventOf(burst);
  return Effect.gen(function* answerEffect() {
    const toolServices = yield* agentToolServices;
    const silenceServices = yield* Effect.context<Inbox | ProactiveMessages>();
    const settledBySilence: RecordedOutcome[] = [];
    const preparation = yield* connectedProactivePreparation(behavior, burst);
    const ownerTools = ownerMessageTools(burst, { ...toolServices, behavior });

    yield* linkBurst(burst);
    yield* runModelTurn({
      ownerId,
      behavior,
      kind: {
        task: "reply",
        event,
        replyTo,
        inputs: burstInputs(burst),
        tools: { ...tools, ...ownerTools },
        prepare: Effect.succeed({
          ...preparation,
          situation: [
            ...(staySilentToolName in ownerTools ? [staySilentSection] : []),
            ...preparation.situation,
          ],
        }),
        traceOf: (model) => traceOf({ event, ...model }),
        whenSilent: settleSilentBurst(burst, settledBySilence).pipe(
          Effect.provideContext(silenceServices)
        ),
        whenFailed: (reason) => failWithNotice(event, reason, replyTo),
      },
    });
    for (const recorded of settledBySilence) {
      yield* recordOutcomeMetric(ownerId, recorded);
    }
  }).pipe(
    whileAcknowledging(replyTo.conversationId, behavior.typingRepeatMillis)
  );
};

const answerBurst = Effect.fnUntraced(function* answerBurst(
  ownerId: OwnerId,
  settings: TurnSettings,
  burst: Burst
) {
  const outcome = yield* settleFromJournal(
    turnEventOf(burst),
    ownerMessageRecovery(burst)
  );
  if (outcome === "unanswered") {
    yield* answer(ownerId, settings, burst);
  }
  yield* settleBurst(burst);
  for (const event of burst) {
    yield* recordOutcomeOfConnectedTurn(ownerId, event.eventId);
  }
});

interface TurnOptions {
  readonly tools?: AgentTools;
}

export const takeTurn = (
  ownerId: OwnerId,
  behavior: BehaviorConfig,
  { tools = noTools }: TurnOptions = {}
) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const schedules = yield* Schedules;
    const startedAt = yield* DateTime.now;
    const wait = burstWaitOf(behavior);
    yield* recordOutcomesOfFinishedTurns(ownerId);
    const newBurstIsDue = yield* inbox.burstIsDue(wait);
    const events = yield* inbox.pending;
    const ownerMessages = events.filter(
      (event) => event._tag === "OwnerMessage"
    );
    const bursts = yield* pendingBursts(ownerMessages, newBurstIsDue);
    const inBursts = new Set(bursts.flat().map((event) => event.eventId));
    const waiting = new Set(
      (yield* inbox.pending).map((event) => event.eventId)
    );
    for (const event of ownerMessages) {
      if (!inBursts.has(event.eventId) && !waiting.has(event.eventId)) {
        yield* recordOutcomeOfConnectedTurn(ownerId, event.eventId);
      }
    }
    for (const burst of bursts) {
      yield* answerBurst(ownerId, { behavior, tools }, burst);
    }
    for (const event of events) {
      if (event._tag === "ScheduleFired") {
        yield* handleFiredSchedule(ownerId, behavior, event);
      }
    }
    yield* schedules.rearmWithoutFailing;
    const untaken = !newBurstIsDue || (yield* inbox.burstGrewSince(startedAt));
    return { nextBurstIsDue: untaken && (yield* inbox.burstIsDue(wait)) };
  });
