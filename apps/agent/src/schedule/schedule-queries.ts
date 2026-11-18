import {
  and,
  asc,
  count,
  eq,
  isNotNull,
  lte,
  ne,
  notExists,
} from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import type { OwnerId } from "../owner-id.ts";
import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import { inboxEvents, schedules } from "../personal-agent/storage-schema.ts";
import { ActiveScheduledTaskLimitReached } from "./active-scheduled-task-limit-reached.ts";
import { actionColumnOfTag, columnsOfAction } from "./schedule-action.ts";
import { recurrenceValuesOf } from "./schedule-requests.ts";
import type {
  ScheduleEditValues,
  SetScheduleRequest,
} from "./schedule-requests.ts";
import { toSchedule } from "./schedule.ts";

type Database = AgentStorage["Service"]["database"];

const hasNoInboxEventForDueInstant = (database: Database) =>
  notExists(
    database
      .select({ one: inboxEvents.eventId })
      .from(inboxEvents)
      .where(
        and(
          eq(inboxEvents.scheduleId, schedules.scheduleId),
          eq(inboxEvents.dueAt, schedules.nextDueAt)
        )
      )
  );

/**
 * Reads and row updates of the `schedules` table for one Owner. It has no
 * Journal writes, no transactions, and no alarm: the Schedules store owns them.
 */
export const scheduleQueriesOf = (database: Database, ownerId: OwnerId) => {
  const ownSchedule = (scheduleId: string) =>
    and(eq(schedules.ownerId, ownerId), eq(schedules.scheduleId, scheduleId));

  const activeScheduleOf = (scheduleId: string) =>
    and(ownSchedule(scheduleId), eq(schedules.state, "active"));

  const dueActive = (scheduleId: string, dueAt: string) =>
    and(activeScheduleOf(scheduleId), eq(schedules.nextDueAt, dueAt));

  const unfiredActive = and(
    eq(schedules.ownerId, ownerId),
    eq(schedules.state, "active"),
    hasNoInboxEventForDueInstant(database)
  );

  const findByRequest = (sourceEventId: string, requestKey: string) =>
    database
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.sourceEventId, sourceEventId),
          eq(schedules.requestKey, requestKey)
        )
      )
      .pipe(Effect.map(([row]) => row));

  const byId = (scheduleId: string) =>
    database
      .select()
      .from(schedules)
      .where(ownSchedule(scheduleId))
      .pipe(
        Effect.map(([row]) =>
          Option.fromNullishOr(row).pipe(Option.map(toSchedule))
        )
      );

  const earliestUnfiredDueAt = database
    .select({ nextDueAt: schedules.nextDueAt })
    .from(schedules)
    .where(unfiredActive)
    .orderBy(asc(schedules.nextDueAt))
    .limit(1)
    .pipe(
      Effect.map(([row]) =>
        Option.fromNullishOr(row).pipe(
          Option.map(({ nextDueAt }) => DateTime.makeUnsafe(nextDueAt))
        )
      )
    );

  const unfiredDueBy = (now: DateTime.Utc) =>
    database
      .select()
      .from(schedules)
      .where(
        and(unfiredActive, lte(schedules.nextDueAt, DateTime.formatIso(now)))
      )
      .orderBy(asc(schedules.nextDueAt), asc(schedules.createdAt))
      .pipe(Effect.map((rows) => rows.map(toSchedule)));

  const listActive = database
    .select()
    .from(schedules)
    .where(and(eq(schedules.ownerId, ownerId), eq(schedules.state, "active")))
    .orderBy(asc(schedules.nextDueAt), asc(schedules.createdAt))
    .pipe(Effect.map((rows) => rows.map(toSchedule)));

  const countActiveScheduledTasks = () =>
    database
      .select({ active: count() })
      .from(schedules)
      .where(
        and(
          eq(schedules.ownerId, ownerId),
          eq(schedules.action, actionColumnOfTag("RunPrompt")),
          eq(schedules.state, "active")
        )
      )
      .pipe(Effect.map(([row]) => row?.active ?? 0));

  const updateActive = Effect.fnUntraced(function* updateActive(
    scheduleId: string,
    values: ScheduleEditValues
  ) {
    const [row] = yield* database
      .update(schedules)
      .set({
        ...values,
        changedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .where(activeScheduleOf(scheduleId))
      .returning();
    return Option.fromNullishOr(row).pipe(Option.map(toSchedule));
  });

  const requireRoomForScheduledTask = Effect.fnUntraced(
    function* requireRoomForScheduledTask(limit: number | undefined) {
      if (
        limit !== undefined &&
        (yield* countActiveScheduledTasks()) >= limit
      ) {
        return yield* new ActiveScheduledTaskLimitReached({ limit });
      }
    }
  );

  const findActive = (scheduleId: string) =>
    database.select().from(schedules).where(activeScheduleOf(scheduleId));

  const findDue = (scheduleId: string, dueAt: string) =>
    database.select().from(schedules).where(dueActive(scheduleId, dueAt));

  const updateDue = (
    scheduleId: string,
    dueAt: string,
    values: ScheduleEditValues
  ) =>
    database.update(schedules).set(values).where(dueActive(scheduleId, dueAt));

  const updateRow = (scheduleId: string, values: ScheduleEditValues) =>
    database.update(schedules).set(values).where(ownSchedule(scheduleId));

  const activeRepeatingOutsideZone = (zoneName: string) =>
    database
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

  const insertSchedule = Effect.fnUntraced(function* insertSchedule(
    request: SetScheduleRequest,
    requestKey: string
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const [inserted] = yield* database
      .insert(schedules)
      .values({
        scheduleId: crypto.randomUUID(),
        ownerId,
        ...columnsOfAction(request.action),
        setBy: request.setBy,
        noteId: request.noteId ?? null,
        nextDueAt: DateTime.formatIso(request.dueAt),
        ...recurrenceValuesOf(request.repeat),
        state: "active",
        sourceEventId: request.sourceEventId,
        requestKey,
        createdAt: now,
        changedAt: now,
      })
      .onConflictDoNothing({
        target: [schedules.sourceEventId, schedules.requestKey],
      })
      .returning();
    return inserted;
  });

  return {
    activeRepeatingOutsideZone,
    byId,
    earliestUnfiredDueAt,
    findActive,
    findByRequest,
    findDue,
    insertSchedule,
    listActive,
    requireRoomForScheduledTask,
    unfiredDueBy,
    updateActive,
    updateDue,
    updateRow,
  };
};
