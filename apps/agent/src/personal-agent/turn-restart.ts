import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import {
  answeringTurnEventIdOf,
  Journal,
  restartCountOf,
} from "../journal/journal.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import type { TurnTrace } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { turnEventOf } from "./burst.ts";
import type { Burst } from "./burst.ts";
import { deliveryStateOf } from "./delivery.ts";
import { Inbox } from "./inbox.ts";
import type { OwnerMessageEvent } from "./inbox.ts";

export interface Restart {
  readonly coveredEventIds: readonly string[];
  readonly newEventIds: readonly string[];
  readonly restartCount: number;
}

export const restartSection =
  "Some of the Owner's messages arrived while you were still working on the earlier ones, so you start again with all of them. Steps that you already finished for this Turn are shown after the messages and are done: do not do them again. Answer once for all the messages, and act on what the later messages add or change.";

const arrivedAfter = Effect.fnUntraced(function* arrivedAfter(burst: Burst) {
  const inbox = yield* Inbox;
  const journal = yield* Journal;
  const inBurst = new Set(burst.map((event) => event.eventId));
  const owners = (yield* inbox.pending).filter(
    (event): event is OwnerMessageEvent => event._tag === "OwnerMessage"
  );
  const newestIndex = owners.findLastIndex((event) =>
    inBurst.has(event.eventId)
  );
  const later: OwnerMessageEvent[] = [];
  if (newestIndex === -1) {
    return later;
  }
  for (const event of owners.slice(newestIndex + 1)) {
    const entries = yield* journal.readForEvent(event.eventId);
    if (
      answeringTurnEventIdOf(entries) === undefined &&
      (yield* deliveryStateOf(event.eventId))._tag === "Unsent"
    ) {
      later.push(event);
    }
  }
  return later;
});

export const restartOf = Effect.fnUntraced(function* restartOf(
  burst: Burst,
  behavior: BehaviorConfig
) {
  const journal = yield* Journal;
  const later = yield* arrivedAfter(burst);
  if (later.length === 0) {
    return Option.none<Restart>();
  }
  const turnEvent = turnEventOf(burst);
  const restartsDone = restartCountOf(
    yield* journal.readForEvent(turnEvent.eventId)
  );
  const now = yield* DateTime.now;
  const waitedMillis =
    DateTime.toEpochMillis(now) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(turnEvent.receivedAt));
  if (
    restartsDone >= behavior.burstMaxRestarts ||
    waitedMillis >= behavior.burstMaxWaitMillis
  ) {
    return Option.none<Restart>();
  }
  const newEventIds = later.map((event) => event.eventId);
  return Option.some<Restart>({
    coveredEventIds: [...burst.map((event) => event.eventId), ...newEventIds],
    newEventIds,
    restartCount: restartsDone + 1,
  });
});

export const restartCountForTurn = Effect.fnUntraced(
  function* restartCountForTurn(eventId: string) {
    const journal = yield* Journal;
    return restartCountOf(yield* journal.readForEvent(eventId));
  }
);

export const recordSuperseded = Effect.fnUntraced(function* recordSuperseded(
  restart: Restart,
  trace: TurnTrace,
  eventId: string
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const traces = yield* TurnTraces;
  yield* database.transaction(() =>
    journal
      .append({
        _tag: "TurnSuperseded",
        eventId,
        coveredEventIds: restart.coveredEventIds,
        newEventIds: restart.newEventIds,
      })
      .pipe(Effect.andThen(traces.record(trace)))
  );
});
