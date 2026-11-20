import { and, eq, max, min } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { AgentStorage } from "./agent-storage.ts";
import { inboxEvents } from "./storage-schema.ts";

export interface BurstWait {
  readonly quietMillis: number;
  readonly maxWaitMillis: number;
}

export const burstWaitOf = (behavior: BehaviorConfig): BurstWait => ({
  quietMillis: behavior.burstQuietMillis,
  maxWaitMillis: behavior.burstMaxWaitMillis,
});

const burstRecheckMillis = 60_000;

interface PendingSpan {
  readonly first: DateTime.Utc;
  readonly newest: DateTime.Utc;
}

const answerAtOf = ({ first, newest }: PendingSpan, wait: BurstWait) =>
  DateTime.min(
    DateTime.add(newest, { milliseconds: wait.quietMillis }),
    DateTime.add(first, { milliseconds: wait.maxWaitMillis })
  );

export const makeBurstWaitQueries = (
  database: AgentStorage["Service"]["database"]
) => {
  const pendingSpan = database
    .select({
      first: min(inboxEvents.receivedAt),
      newest: max(inboxEvents.receivedAt),
    })
    .from(inboxEvents)
    .where(
      and(
        eq(inboxEvents.state, "pending"),
        eq(inboxEvents.kind, "OwnerMessage")
      )
    )
    .pipe(
      Effect.map(([row]) =>
        Option.all({
          first: Option.fromNullishOr(row?.first),
          newest: Option.fromNullishOr(row?.newest),
        }).pipe(
          Option.map(({ first, newest }): PendingSpan => ({
            first: DateTime.makeUnsafe(first),
            newest: DateTime.makeUnsafe(newest),
          }))
        )
      )
    );

  const burstAnswerAt = (wait: BurstWait) =>
    pendingSpan.pipe(Effect.map(Option.map((span) => answerAtOf(span, wait))));

  const burstIsDue = (wait: BurstWait) =>
    Effect.all([burstAnswerAt(wait), DateTime.now]).pipe(
      Effect.map(([answerAt, now]) =>
        Option.exists(answerAt, (at) => DateTime.isLessThanOrEqualTo(at, now))
      )
    );

  const burstGrewSince = (instant: DateTime.Utc) =>
    pendingSpan.pipe(
      Effect.map(
        Option.exists(({ newest }) => DateTime.isGreaterThan(newest, instant))
      )
    );

  const burstAlarmAt = (wait: BurstWait) =>
    Effect.all([burstAnswerAt(wait), DateTime.now]).pipe(
      Effect.map(([answerAt, now]) =>
        answerAt.pipe(
          Option.map((at) =>
            DateTime.isGreaterThan(at, now)
              ? at
              : DateTime.add(now, { milliseconds: burstRecheckMillis })
          )
        )
      )
    );

  return { burstIsDue, burstGrewSince, burstAlarmAt };
};
