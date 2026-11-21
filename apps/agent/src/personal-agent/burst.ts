import { Effect } from "effect";

import { answeringTurnEventIdOf, Journal } from "../journal/journal.ts";
import type { NoteSource, TrustLevel } from "../notes/note.ts";
import { noteSourceOfEvent } from "../notes/note.ts";
import { AgentStorage } from "./agent-storage.ts";
import { deliveryStateOf } from "./delivery.ts";
import { eventMessage, numberedEventMessage } from "./event-message.ts";
import { trustLevelOfEvent } from "./event-trust.ts";
import { Inbox } from "./inbox.ts";
import type { OwnerMessageEvent } from "./inbox.ts";

export type Burst = readonly [OwnerMessageEvent, ...OwnerMessageEvent[]];

const oneBurstOf = (events: readonly OwnerMessageEvent[]): Burst[] => {
  const [first, ...rest] = events;
  return first === undefined ? [] : [[first, ...rest]];
};

export const turnEventOf = (burst: Burst) => burst[0];

export const newestEventOf = (burst: Burst) => burst.at(-1) ?? burst[0];

export const burstInputs = (burst: Burst) =>
  burst.length === 1
    ? burst.map(eventMessage)
    : burst.map((event, index) =>
        numberedEventMessage(event, index + 1, burst.length)
      );

export const trustLevelOfBurst = (burst: Burst): TrustLevel =>
  burst.some((event) => trustLevelOfEvent(event) === "untrusted")
    ? "untrusted"
    : "owner";

export type BurstNoteSource =
  | { readonly _tag: "Named"; readonly source: NoteSource }
  | { readonly _tag: "NotNamed" }
  | { readonly _tag: "OutsideBurst"; readonly count: number };

const namedEventOf = (burst: Burst, message: number | undefined) => {
  if (message !== undefined) {
    return burst[message - 1];
  }
  return burst.length > 1 && trustLevelOfBurst(burst) === "untrusted"
    ? undefined
    : turnEventOf(burst);
};

export const noteSourceOfBurst = (
  burst: Burst,
  message: number | undefined
): BurstNoteSource => {
  if (message !== undefined && (message < 1 || message > burst.length)) {
    return { _tag: "OutsideBurst", count: burst.length };
  }
  const named = namedEventOf(burst, message);
  if (named === undefined) {
    return { _tag: "NotNamed" };
  }
  return {
    _tag: "Named",
    source: {
      ...noteSourceOfEvent(named),
      eventId: turnEventOf(burst).eventId,
      trustLevel: trustLevelOfBurst(burst),
    },
  };
};

const answeringTurnOf = Effect.fnUntraced(function* answeringTurnOf(
  event: OwnerMessageEvent
) {
  const journal = yield* Journal;
  return answeringTurnEventIdOf(yield* journal.readForEvent(event.eventId));
});

export const linkBurst = Effect.fnUntraced(function* linkBurst(burst: Burst) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const turnEventId = turnEventOf(burst).eventId;
  const unlinked: OwnerMessageEvent[] = [];
  for (const event of burst.slice(1)) {
    if ((yield* answeringTurnOf(event)) === undefined) {
      unlinked.push(event);
    }
  }
  if (unlinked.length === 0) {
    return;
  }
  yield* database.transaction(() =>
    Effect.forEach(
      unlinked,
      (event) =>
        journal.append({
          _tag: "AnsweredByTurn",
          eventId: event.eventId,
          turnEventId,
        }),
      { discard: true }
    )
  );
});

export const settleWithTurn = Effect.fnUntraced(function* settleWithTurn(
  turnEventId: string,
  events: readonly OwnerMessageEvent[]
) {
  const inbox = yield* Inbox;
  if (events.length === 0) {
    return "settled" as const;
  }
  const state = yield* deliveryStateOf(turnEventId);
  if (state._tag === "Unsent") {
    return "unanswered" as const;
  }
  yield* state._tag === "Sent" || state._tag === "Silent"
    ? inbox.markDone(events)
    : inbox.markFailed(events);
  return "settled" as const;
});

export const settleBurst = (burst: Burst) =>
  settleWithTurn(turnEventOf(burst).eventId, burst.slice(1));

const sortLinkedEvents = Effect.fnUntraced(function* sortLinkedEvents(
  events: readonly OwnerMessageEvent[]
) {
  const pendingIds = new Set(events.map((event) => event.eventId));
  const joined = new Map<string, OwnerMessageEvent[]>();
  const fresh: OwnerMessageEvent[] = [];
  for (const event of events) {
    const turnEventId = yield* answeringTurnOf(event);
    if (turnEventId !== undefined && pendingIds.has(turnEventId)) {
      const linked = joined.get(turnEventId) ?? [];
      linked.push(event);
      joined.set(turnEventId, linked);
      continue;
    }
    const settled =
      turnEventId === undefined
        ? "unanswered"
        : yield* settleWithTurn(turnEventId, [event]);
    if (settled === "unanswered") {
      fresh.push(event);
    }
  }
  return { joined, fresh };
});

export const pendingBursts = Effect.fnUntraced(function* pendingBursts(
  events: readonly OwnerMessageEvent[],
  newBurstIsDue: boolean
) {
  const { joined, fresh } = yield* sortLinkedEvents(events);
  const started = new Set<string>();
  for (const event of fresh) {
    if ((yield* deliveryStateOf(event.eventId))._tag !== "Unsent") {
      started.add(event.eventId);
    }
  }
  const restored = new Map(
    fresh
      .filter((event) => started.has(event.eventId))
      .map((event): [string, Burst] => [
        event.eventId,
        [event, ...(joined.get(event.eventId) ?? [])],
      ])
  );
  const stranded = [...joined]
    .filter(([turnEventId]) => !restored.has(turnEventId))
    .flatMap(([, linked]) => linked);
  const order = new Map(events.map((event, index) => [event.eventId, index]));
  const arrival = (event: OwnerMessageEvent) => order.get(event.eventId) ?? 0;
  const formed = newBurstIsDue
    ? oneBurstOf(
        [
          ...fresh.filter((event) => !restored.has(event.eventId)),
          ...stranded,
        ].toSorted((left, right) => arrival(left) - arrival(right))
      )
    : [];
  const position = (burst: Burst) => arrival(turnEventOf(burst));
  return [...restored.values(), ...formed].toSorted(
    (left, right) => position(left) - position(right)
  );
});
