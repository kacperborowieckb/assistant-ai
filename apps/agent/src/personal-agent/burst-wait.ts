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

const answerAtOf = (
  firstReceivedAt: string,
  newestReceivedAt: string,
  wait: BurstWait
) =>
  DateTime.min(
    DateTime.add(DateTime.makeUnsafe(newestReceivedAt), {
      milliseconds: wait.quietMillis,
    }),
    DateTime.add(DateTime.makeUnsafe(firstReceivedAt), {
      milliseconds: wait.maxWaitMillis,
    })
  );

export const makeBurstWaitQueries = (
  database: AgentStorage["Service"]["database"]
) => {
  const burstAnswerAt = (wait: BurstWait) =>
    database
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
          row?.first === null || row?.first === undefined || row.newest === null
            ? Option.none<DateTime.Utc>()
            : Option.some(answerAtOf(row.first, row.newest, wait))
        )
      );

  const burstIsDue = (wait: BurstWait) =>
    Effect.all([burstAnswerAt(wait), DateTime.now]).pipe(
      Effect.map(([answerAt, now]) =>
        Option.exists(answerAt, (at) => DateTime.isLessThanOrEqualTo(at, now))
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

  return { burstIsDue, burstAlarmAt };
};
