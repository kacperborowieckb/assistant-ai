import { DateTime, Effect, Option } from "effect";

import type { Journal } from "../journal/journal.ts";
import type { proactiveHoldReasons } from "../personal-agent/storage-values.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import type { makeScheduleQueries } from "./schedule-queries.ts";
import { toSchedule } from "./schedule.ts";

export interface ScheduleHold {
  readonly scheduleId: string;
  readonly fromDueAt: string;
  readonly toDueAt: DateTime.Utc;
  readonly reason: (typeof proactiveHoldReasons)[number];
  readonly eventId: string;
}

type ScheduleQueries = Effect.Success<ReturnType<typeof makeScheduleQueries>>;

type InTransaction = <A, E, R>(
  work: Effect.Effect<A, E, R>
) => Effect.Effect<A, unknown, R>;

export const makeScheduleMoves = (
  queries: ScheduleQueries,
  journal: Journal["Service"],
  inTransaction: InTransaction
) => {
  const moveRepeatingInTransaction = Effect.fnUntraced(
    function* moveRepeatingInTransaction(
      timeZone: DateTime.TimeZone.Named,
      eventId: string
    ) {
      const now = yield* DateTime.now;
      const zoneName = DateTime.zoneToString(timeZone);
      const rows = yield* queries.activeRepeatingOutsideZone(zoneName);
      for (const row of rows) {
        const { rule } = Option.getOrThrow(
          Option.fromNullishOr(toSchedule(row).repeat)
        );
        yield* queries.updateActive(row.scheduleId, {
          nextDueAt: DateTime.formatIso(nextOccurrence(rule, now, timeZone)),
          recurrenceTimeZone: zoneName,
          changedAt: DateTime.formatIso(now),
        });
        yield* journal.append({
          _tag: "ScheduleChanged",
          eventId,
          scheduleId: row.scheduleId,
        });
      }
    }
  );

  const holdInTransaction = Effect.fnUntraced(function* holdInTransaction(
    request: ScheduleHold
  ) {
    const recorded = (yield* journal.readForEvent(request.eventId)).find(
      ({ record }) =>
        record._tag === "ProactiveMessageHeld" &&
        record.scheduleId === request.scheduleId
    );
    const toDueAt =
      recorded?.record._tag === "ProactiveMessageHeld"
        ? recorded.record.toDueAt
        : DateTime.formatIso(request.toDueAt);
    const held = yield* queries.updateDue(
      request.scheduleId,
      request.fromDueAt,
      {
        nextDueAt: toDueAt,
        changedAt: DateTime.formatIso(yield* DateTime.now),
      }
    );
    if (Option.isNone(held)) {
      return false;
    }
    if (recorded === undefined) {
      yield* journal.append({
        _tag: "ProactiveMessageHeld",
        eventId: request.eventId,
        scheduleId: request.scheduleId,
        fromDueAt: request.fromDueAt,
        toDueAt,
        reason: request.reason,
      });
    }
    return true;
  });

  return {
    moveRepeatingToTimeZone: (
      timeZone: DateTime.TimeZone.Named,
      eventId: string
    ) => inTransaction(moveRepeatingInTransaction(timeZone, eventId)),
    hold: (request: ScheduleHold) => inTransaction(holdInTransaction(request)),
  };
};
