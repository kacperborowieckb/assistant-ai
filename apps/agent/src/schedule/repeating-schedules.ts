import { and, eq, isNotNull, ne } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { schedules } from "../personal-agent/storage-schema.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import { toSchedule } from "./schedule.ts";

export const makeRepeatingSchedules = Effect.fnUntraced(
  function* makeRepeatingSchedules(ownerId: OwnerId) {
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;

    const moveRepeatingToTimeZone = (
      timeZone: DateTime.TimeZone.Named,
      eventId: string
    ) =>
      database.transaction(() =>
        Effect.gen(function* moveEffect() {
          const now = yield* DateTime.now;
          const zoneName = DateTime.zoneToString(timeZone);
          const rows = yield* database
            .select()
            .from(schedules)
            .where(
              and(
                eq(schedules.ownerId, ownerId),
                eq(schedules.state, "active"),
                isNotNull(schedules.recurrence),
                ne(schedules.recurrenceTimeZone, zoneName)
              )
            );
          for (const row of rows) {
            const { rule } = Option.getOrThrow(
              Option.fromNullishOr(toSchedule(row).repeat)
            );
            const nextDueAt = DateTime.formatIso(
              nextOccurrence(rule, now, timeZone)
            );
            yield* database
              .update(schedules)
              .set({
                nextDueAt,
                recurrenceTimeZone: zoneName,
                changedAt: DateTime.formatIso(now),
              })
              .where(eq(schedules.scheduleId, row.scheduleId));
            yield* journal.append({
              _tag: "ScheduleChanged",
              eventId,
              scheduleId: row.scheduleId,
            });
          }
        })
      );

    return { moveRepeatingToTimeZone };
  }
);
