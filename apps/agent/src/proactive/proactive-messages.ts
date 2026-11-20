import { and, eq, isNull, ne } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";

import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import {
  decodeOpenLoopIds,
  encodeOpenLoopIds,
  makeProactiveOutcomes,
} from "./proactive-outcomes.ts";
import { proactiveMessages } from "./proactive-schema.ts";

const encodeIds = encodeOpenLoopIds;
const decodeIds = decodeOpenLoopIds;

const makeProactiveMessages = Effect.gen(
  function* makeProactiveMessagesEffect() {
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;

    const forEvent = Effect.fnUntraced(function* forEvent(eventId: string) {
      const [row] = yield* database
        .select()
        .from(proactiveMessages)
        .where(eq(proactiveMessages.eventId, eventId));
      return row === undefined
        ? undefined
        : {
            eventId: row.eventId,
            sentMessageId: row.sentMessageId,
            openLoopIds: decodeIds(row.openLoopIds),
            outcome: row.outcome,
          };
    });

    const plan = Effect.fnUntraced(function* plan(
      eventId: string,
      openLoopIds: readonly string[]
    ) {
      yield* database
        .insert(proactiveMessages)
        .values({
          eventId,
          openLoopIds: encodeIds(openLoopIds),
          plannedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .onConflictDoNothing();
      const entries = yield* journal.readForEvent(eventId);
      if (
        !entries.some(({ record }) => record._tag === "ProactiveMessagePlanned")
      ) {
        yield* journal.append({ _tag: "ProactiveMessagePlanned", eventId });
      }
      const planned = yield* forEvent(eventId);
      return planned?.openLoopIds ?? openLoopIds;
    });

    const plannedOpenLoops = Effect.fnUntraced(function* plannedOpenLoops(
      exceptEventId: string
    ) {
      const rows = yield* database
        .select({
          eventId: proactiveMessages.eventId,
          openLoopIds: proactiveMessages.openLoopIds,
        })
        .from(proactiveMessages)
        .where(ne(proactiveMessages.eventId, exceptEventId));
      return rows.map((row) => ({
        eventId: row.eventId,
        openLoopIds: decodeIds(row.openLoopIds),
      }));
    });

    const recordSent = Effect.fnUntraced(function* recordSent(
      eventId: string,
      sentMessageId: string,
      responseWindowMillis: number
    ) {
      const entries = yield* journal.readForEvent(eventId);
      const delivered = entries.findLast(
        (entry) => entry.record._tag === "ReplySent"
      );
      const sentAt =
        delivered === undefined
          ? yield* DateTime.now
          : DateTime.makeUnsafe(delivered.recordedAt);
      yield* database
        .update(proactiveMessages)
        .set({
          sentMessageId,
          sentAt: DateTime.formatIso(sentAt),
          windowEndsAt: DateTime.formatIso(
            DateTime.add(sentAt, { milliseconds: responseWindowMillis })
          ),
        })
        .where(
          and(
            eq(proactiveMessages.eventId, eventId),
            isNull(proactiveMessages.sentMessageId)
          )
        );
    });

    return {
      plan,
      plannedOpenLoops,
      recordSent,
      forEvent,
      ...makeProactiveOutcomes(database, journal),
    };
  }
);

export class ProactiveMessages extends Context.Service<
  ProactiveMessages,
  Effect.Success<typeof makeProactiveMessages>
>()("ProactiveMessages") {
  static readonly layer = Layer.effect(
    ProactiveMessages,
    makeProactiveMessages
  );
}
