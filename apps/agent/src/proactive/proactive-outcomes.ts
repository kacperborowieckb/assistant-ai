import { and, desc, eq, isNotNull, isNull, like, lt, ne } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";

import type { Journal } from "../journal/journal.ts";
import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import { inboxEvents } from "../personal-agent/storage-schema.ts";
import type { ProactiveOutcome } from "../personal-agent/storage-values.ts";
import { outcomeOfConnectedTurn } from "./outcome-rules.ts";
import { proactiveMessages } from "./proactive-schema.ts";

const OpenLoopIdsJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.String)
);

export const encodeOpenLoopIds = Schema.encodeSync(OpenLoopIdsJsonSchema);

export const decodeOpenLoopIds = Schema.decodeUnknownSync(
  OpenLoopIdsJsonSchema
);

const decodeIds = decodeOpenLoopIds;

export const recentOutcomesPerOpenLoop = 3;

export interface RecordedOutcome {
  readonly eventId: string;
  readonly outcome: ProactiveOutcome;
  readonly responseMillis: number;
}

export const makeProactiveOutcomes = (
  database: AgentStorage["Service"]["database"],
  journal: Journal["Service"]
) => {
  const connect = Effect.fnUntraced(function* connect(
    ownerMessageEventId: string
  ) {
    const now = yield* DateTime.now;
    const [latest] = yield* database
      .select()
      .from(proactiveMessages)
      .where(isNotNull(proactiveMessages.sentMessageId))
      .orderBy(
        desc(proactiveMessages.sentAt),
        desc(proactiveMessages.plannedAt)
      )
      .limit(1);
    if (
      latest === undefined ||
      latest.outcome !== null ||
      latest.connectedEventId !== null ||
      latest.windowEndsAt === null ||
      DateTime.isGreaterThan(now, DateTime.makeUnsafe(latest.windowEndsAt))
    ) {
      return;
    }
    yield* database
      .update(proactiveMessages)
      .set({ connectedEventId: ownerMessageEventId })
      .where(
        and(
          eq(proactiveMessages.eventId, latest.eventId),
          isNull(proactiveMessages.connectedEventId),
          isNull(proactiveMessages.outcome)
        )
      );
  });

  const connectedTo = Effect.fnUntraced(function* connectedTo(
    ownerMessageEventId: string
  ) {
    const [row] = yield* database
      .select()
      .from(proactiveMessages)
      .where(eq(proactiveMessages.connectedEventId, ownerMessageEventId));
    return row === undefined
      ? undefined
      : {
          eventId: row.eventId,
          openLoopIds: decodeIds(row.openLoopIds),
          outcome: row.outcome,
        };
  });

  const settle = (
    eventId: string,
    outcome: ProactiveOutcome,
    connectedEventId: string | null
  ) =>
    database.transaction(() =>
      Effect.gen(function* settleEffect() {
        const now = yield* DateTime.now;
        const [updated] = yield* database
          .update(proactiveMessages)
          .set({ outcome })
          .where(
            and(
              eq(proactiveMessages.eventId, eventId),
              isNull(proactiveMessages.outcome),
              isNotNull(proactiveMessages.sentAt)
            )
          )
          .returning({ sentAt: proactiveMessages.sentAt });
        if (updated?.sentAt === undefined || updated.sentAt === null) {
          return Option.none<RecordedOutcome>();
        }
        yield* journal.append({
          _tag: "ProactiveMessageOutcome",
          eventId,
          outcome,
          connectedEventId,
        });
        return Option.some<RecordedOutcome>({
          eventId,
          outcome,
          responseMillis:
            DateTime.toEpochMillis(now) -
            DateTime.toEpochMillis(DateTime.makeUnsafe(updated.sentAt)),
        });
      })
    );

  const recordOutcomeOfConnectedTurn = Effect.fnUntraced(
    function* recordOutcomeOfConnectedTurn(ownerMessageEventId: string) {
      const connected = yield* connectedTo(ownerMessageEventId);
      if (connected === undefined) {
        return Option.none<RecordedOutcome>();
      }
      const entries = yield* journal.readForEvent(ownerMessageEventId);
      return yield* settle(
        connected.eventId,
        outcomeOfConnectedTurn(connected.openLoopIds, entries),
        ownerMessageEventId
      );
    }
  );

  const connectedTurnsAwaitingOutcome = () =>
    database
      .select({ eventId: inboxEvents.eventId })
      .from(proactiveMessages)
      .innerJoin(
        inboxEvents,
        eq(inboxEvents.eventId, proactiveMessages.connectedEventId)
      )
      .where(
        and(isNull(proactiveMessages.outcome), ne(inboxEvents.state, "pending"))
      )
      .pipe(Effect.map((rows) => rows.map(({ eventId }) => eventId)));

  const settleFinishedTurns = Effect.fnUntraced(
    function* settleFinishedTurns() {
      const finished = yield* connectedTurnsAwaitingOutcome();
      const recorded: RecordedOutcome[] = [];
      for (const ownerMessageEventId of finished) {
        const settled =
          yield* recordOutcomeOfConnectedTurn(ownerMessageEventId);
        if (Option.isSome(settled)) {
          recorded.push(settled.value);
        }
      }
      return recorded;
    }
  );

  const ignoreExpired = Effect.fnUntraced(function* ignoreExpired() {
    const now = DateTime.formatIso(yield* DateTime.now);
    const expired = yield* database
      .select({ eventId: proactiveMessages.eventId })
      .from(proactiveMessages)
      .where(
        and(
          isNotNull(proactiveMessages.sentAt),
          isNull(proactiveMessages.outcome),
          isNull(proactiveMessages.connectedEventId),
          lt(proactiveMessages.windowEndsAt, now)
        )
      )
      .orderBy(proactiveMessages.windowEndsAt);
    const recorded: RecordedOutcome[] = [];
    for (const { eventId } of expired) {
      const settled = yield* settle(eventId, "ignored", null);
      if (Option.isSome(settled)) {
        recorded.push(settled.value);
      }
    }
    return recorded;
  });

  const recentOutcomesOfOpenLoop = (noteId: string) =>
    database
      .select({ outcome: proactiveMessages.outcome })
      .from(proactiveMessages)
      .where(
        and(
          isNotNull(proactiveMessages.outcome),
          like(
            proactiveMessages.openLoopIds,
            `%${encodeOpenLoopIds([noteId]).slice(1, -1)}%`
          )
        )
      )
      .orderBy(desc(proactiveMessages.sentAt))
      .limit(recentOutcomesPerOpenLoop)
      .pipe(
        Effect.map((rows) =>
          rows.flatMap(({ outcome }) => (outcome === null ? [] : [outcome]))
        )
      );

  const recentOutcomesOf = Effect.fnUntraced(function* recentOutcomesOf(
    openLoopIds: readonly string[]
  ) {
    const entries = yield* Effect.all(
      openLoopIds.map((noteId) =>
        recentOutcomesOfOpenLoop(noteId).pipe(
          Effect.map((outcomes) => [noteId, outcomes] as const)
        )
      )
    );
    return new Map(entries);
  });

  return {
    connect,
    connectedTo,
    recordOutcomeOfConnectedTurn,
    settleFinishedTurns,
    ignoreExpired,
    recentOutcomesOf,
  };
};
