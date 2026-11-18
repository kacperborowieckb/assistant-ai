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
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { inboxEvents, schedules } from "../personal-agent/storage-schema.ts";
import { actionColumnOfTag } from "./schedule-action.ts";
import { toSchedule } from "./schedule.ts";

export type ScheduleRow = typeof schedules.$inferSelect;

export type ScheduleRowValues = Partial<
  Omit<ScheduleRow, "scheduleId" | "ownerId" | "createdAt" | "sourceEventId">
>;

const firstOf = <Row>(rows: readonly Row[]) => Option.fromNullishOr(rows[0]);

export const makeScheduleQueries = Effect.fnUntraced(
  function* makeScheduleQueries(ownerId: OwnerId) {
    const { database } = yield* AgentStorage;

    const ownRow = (scheduleId: string) =>
      and(eq(schedules.ownerId, ownerId), eq(schedules.scheduleId, scheduleId));

    const activeRow = (scheduleId: string) =>
      and(ownRow(scheduleId), eq(schedules.state, "active"));

    const dueRow = (scheduleId: string, dueAt: string) =>
      and(activeRow(scheduleId), eq(schedules.nextDueAt, dueAt));

    const hasNoInboxEventForDueInstant = notExists(
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

    const unfiredActive = and(
      eq(schedules.ownerId, ownerId),
      eq(schedules.state, "active"),
      hasNoInboxEventForDueInstant
    );

    const listActive = database
      .select()
      .from(schedules)
      .where(and(eq(schedules.ownerId, ownerId), eq(schedules.state, "active")))
      .orderBy(asc(schedules.nextDueAt), asc(schedules.createdAt))
      .pipe(Effect.map((rows) => rows.map(toSchedule)));

    const countActiveScheduledTasks = database
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

    const byId = (scheduleId: string) =>
      database
        .select()
        .from(schedules)
        .where(ownRow(scheduleId))
        .pipe(Effect.map((rows) => firstOf(rows).pipe(Option.map(toSchedule))));

    const activeRowById = (scheduleId: string) =>
      database
        .select()
        .from(schedules)
        .where(activeRow(scheduleId))
        .pipe(Effect.map(firstOf));

    const dueRowById = (scheduleId: string, dueAt: string) =>
      database
        .select()
        .from(schedules)
        .where(dueRow(scheduleId, dueAt))
        .pipe(Effect.map(firstOf));

    const findByRequest = (sourceEventId: string, requestKey: string) =>
      database
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.ownerId, ownerId),
            eq(schedules.sourceEventId, sourceEventId),
            eq(schedules.requestKey, requestKey)
          )
        )
        .pipe(Effect.map(firstOf));

    const earliestUnfiredDueAt = database
      .select({ nextDueAt: schedules.nextDueAt })
      .from(schedules)
      .where(unfiredActive)
      .orderBy(asc(schedules.nextDueAt))
      .limit(1)
      .pipe(
        Effect.map((rows) =>
          firstOf(rows).pipe(
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

    const insert = (values: typeof schedules.$inferInsert) =>
      database
        .insert(schedules)
        .values(values)
        .onConflictDoNothing({
          target: [schedules.sourceEventId, schedules.requestKey],
        })
        .returning()
        .pipe(Effect.map(firstOf));

    const updateActive = (scheduleId: string, values: ScheduleRowValues) =>
      database
        .update(schedules)
        .set(values)
        .where(activeRow(scheduleId))
        .returning()
        .pipe(Effect.map(firstOf));

    const updateDue = (
      scheduleId: string,
      dueAt: string,
      values: ScheduleRowValues
    ) =>
      database
        .update(schedules)
        .set(values)
        .where(dueRow(scheduleId, dueAt))
        .returning()
        .pipe(Effect.map(firstOf));

    return {
      listActive,
      countActiveScheduledTasks,
      byId,
      activeRowById,
      dueRowById,
      findByRequest,
      earliestUnfiredDueAt,
      unfiredDueBy,
      activeRepeatingOutsideZone,
      insert,
      updateActive,
      updateDue,
    };
  }
);
