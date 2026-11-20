import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { NoteSource, TrustLevel } from "../notes/note.ts";
import { noteSourceOfEvent } from "../notes/note.ts";
import { AgentStorage } from "./agent-storage.ts";
import { deliveryStateOf } from "./delivery.ts";
import { eventMessage } from "./event-message.ts";
import { trustLevelOfEvent } from "./event-trust.ts";
import { Inbox } from "./inbox.ts";
import type { OwnerMessageEvent } from "./inbox.ts";

/**
 * The pending Owner message Events that one Turn answers, in arrival order.
 * The first Event is the Turn Event: it keys the Delivery, the Turn progress,
 * the Conversation, the Trace, and the metric, so the key stays the same when
 * a later message joins the burst. The outcome goes to the newest message.
 */
export type Burst = readonly [OwnerMessageEvent, ...OwnerMessageEvent[]];

export type FormBursts = (
  events: readonly OwnerMessageEvent[]
) => readonly Burst[];

export const oneEventBursts: FormBursts = (events) =>
  events.map((event): Burst => [event]);

export const turnEventOf = (burst: Burst) => burst[0];

export const newestEventOf = (burst: Burst) => burst.at(-1) ?? burst[0];

export const burstInputs = (burst: Burst) => burst.map(eventMessage);

export const trustLevelOfBurst = (burst: Burst): TrustLevel =>
  burst.some((event) => trustLevelOfEvent(event) === "untrusted")
    ? "untrusted"
    : "owner";

export const noteSourceOfBurst = (burst: Burst): NoteSource => {
  const turnEvent = turnEventOf(burst);
  const sourceEvent =
    burst.find((event) => trustLevelOfEvent(event) === "untrusted") ??
    turnEvent;
  return {
    ...noteSourceOfEvent(sourceEvent),
    eventId: turnEvent.eventId,
    trustLevel: trustLevelOfBurst(burst),
  };
};

const answeringTurnOf = Effect.fnUntraced(function* answeringTurnOf(
  event: OwnerMessageEvent
) {
  const journal = yield* Journal;
  const entries = yield* journal.readForEvent(event.eventId);
  const link = entries.find((entry) => entry.record._tag === "AnsweredByTurn");
  return link?.record._tag === "AnsweredByTurn"
    ? link.record.turnEventId
    : undefined;
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
  yield* state._tag === "Sent"
    ? inbox.markDone(events)
    : inbox.markFailed(events);
  return "settled" as const;
});

export const settleBurst = (burst: Burst) =>
  settleWithTurn(turnEventOf(burst).eventId, burst.slice(1));

/**
 * Forms the bursts of the pending Owner messages. An Event that the Journal
 * links to a Turn joins the burst of that Turn when the Turn Event is still
 * pending, and is settled from the Delivery of that Turn when it is not, so
 * recovery after a reset never answers it again.
 */
export const pendingBursts = Effect.fnUntraced(function* pendingBursts(
  events: readonly OwnerMessageEvent[],
  formBursts: FormBursts
) {
  const pendingIds = new Set(events.map((event) => event.eventId));
  const joined = new Map<string, OwnerMessageEvent[]>();
  const fresh: OwnerMessageEvent[] = [];
  for (const event of events) {
    const turnEventId = yield* answeringTurnOf(event);
    if (turnEventId !== undefined && pendingIds.has(turnEventId)) {
      joined.set(turnEventId, [...(joined.get(turnEventId) ?? []), event]);
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
  const restored = new Map(
    fresh
      .filter((event) => joined.has(event.eventId))
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
  const formed = formBursts(
    [
      ...fresh.filter((event) => !restored.has(event.eventId)),
      ...stranded,
    ].toSorted((left, right) => arrival(left) - arrival(right))
  );
  const position = (burst: Burst) => arrival(turnEventOf(burst));
  return [...restored.values(), ...formed].toSorted(
    (left, right) => position(left) - position(right)
  );
});
