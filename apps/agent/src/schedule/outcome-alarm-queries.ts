import { and, eq, isNotNull, isNull, min, ne } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import { inboxEvents } from "../personal-agent/storage-schema.ts";
import { proactiveMessages } from "../proactive/proactive-schema.ts";

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

  const finishedTurnAwaitingOutcome = database
    .select({ eventId: inboxEvents.eventId })
    .from(proactiveMessages)
    .innerJoin(
      inboxEvents,
      eq(inboxEvents.eventId, proactiveMessages.connectedEventId)
    )
    .where(
      and(isNull(proactiveMessages.outcome), ne(inboxEvents.state, "pending"))
    )
    .limit(1)
    .pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.succeed(Option.none<DateTime.Utc>())
          : DateTime.now.pipe(Effect.map((now) => Option.some(now)))
      )
    );

  const earliestOutcomeAlarmAt = Effect.all([
    earliestWindowEnd,
    finishedTurnAwaitingOutcome,
  ]).pipe(Effect.map(([windowEnd, now]) => earlierOf(windowEnd, now)));

  return { earliestOutcomeAlarmAt };
};
