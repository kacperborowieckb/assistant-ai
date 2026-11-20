import { and, eq, isNotNull, isNull, min } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import { inboxEvents } from "../personal-agent/storage-schema.ts";
import { proactiveMessages } from "../proactive/proactive-schema.ts";

const pendingTurnRecheckMillis = 60_000;

export const earlierOf = (
  first: Option.Option<DateTime.Utc>,
  second: Option.Option<DateTime.Utc>
) => {
  if (Option.isNone(first)) {
    return second;
  }
  if (Option.isNone(second)) {
    return first;
  }
  return Option.some(DateTime.min(first.value, second.value));
};

export const makeOutcomeAlarmQueries = (
  database: AgentStorage["Service"]["database"]
) => {
  const earliestWindowEnd = database
    .select({ windowEndsAt: min(proactiveMessages.windowEndsAt) })
    .from(proactiveMessages)
    .where(
      and(
        isNotNull(proactiveMessages.sentAt),
        isNull(proactiveMessages.outcome),
        isNull(proactiveMessages.connectedEventId)
      )
    )
    .pipe(
      Effect.map(([row]) =>
        Option.fromNullishOr(row?.windowEndsAt).pipe(
          Option.map((windowEndsAt) =>
            DateTime.add(DateTime.makeUnsafe(windowEndsAt), {
              milliseconds: 1,
            })
          )
        )
      )
    );

  const connectedTurnAwaitingOutcome = database
    .select({ state: inboxEvents.state })
    .from(proactiveMessages)
    .innerJoin(
      inboxEvents,
      eq(inboxEvents.eventId, proactiveMessages.connectedEventId)
    )
    .where(isNull(proactiveMessages.outcome))
    .pipe(
      Effect.flatMap((rows) => {
        if (rows.length === 0) {
          return Effect.succeed(Option.none<DateTime.Utc>());
        }
        const hasFinished = rows.some(({ state }) => state !== "pending");
        return DateTime.now.pipe(
          Effect.map((now) =>
            Option.some(
              hasFinished
                ? now
                : DateTime.add(now, { milliseconds: pendingTurnRecheckMillis })
            )
          )
        );
      })
    );

  const earliestOutcomeAlarmAt = Effect.all([
    earliestWindowEnd,
    connectedTurnAwaitingOutcome,
  ]).pipe(Effect.map(([windowEnd, now]) => earlierOf(windowEnd, now)));

  return { earliestOutcomeAlarmAt };
};
