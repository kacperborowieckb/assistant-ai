import { and, asc, count, eq } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { schedules } from "../personal-agent/storage-schema.ts";
import { ActiveScheduledTaskLimitReached } from "./active-scheduled-task-limit-reached.ts";
import { actionColumnOfTag, columnsOfAction } from "./schedule-action.ts";
import type { ScheduleAction } from "./schedule-action.ts";
import { encodeRule, toSchedule } from "./schedule.ts";
import type { Repeat } from "./schedule.ts";

export interface ScheduleChangeRequest {
  readonly scheduleId: string;
  readonly action?: ScheduleAction | undefined;
  readonly dueAt?: DateTime.Utc | undefined;
  readonly repeat?: Repeat | undefined;
  readonly eventId: string;
  readonly activeScheduledTaskLimit?: number | undefined;
}

export interface ScheduleCancelRequest {
  readonly scheduleId: string;
  readonly eventId: string;
}

interface ScheduleEditValues {
  readonly action?: (typeof schedules.$inferSelect)["action"];
  readonly text?: string;
  readonly nextDueAt?: string;
  readonly recurrence?: string | null;
  readonly recurrenceTimeZone?: string | null;
  readonly state?: "cancelled";
}

export const recurrenceValuesOf = (repeat: Repeat | undefined) => ({
  recurrence: repeat === undefined ? null : encodeRule(repeat.rule),
  recurrenceTimeZone:
    repeat === undefined ? null : DateTime.zoneToString(repeat.timeZone),
});

export const makeScheduleEdits = Effect.fnUntraced(function* makeScheduleEdits(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

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
      .where(
        and(
          eq(schedules.ownerId, ownerId),
          eq(schedules.scheduleId, scheduleId),
          eq(schedules.state, "active")
        )
      )
      .returning();
    return Option.fromNullishOr(row).pipe(Option.map(toSchedule));
  });

  const change = (request: ScheduleChangeRequest) =>
    database.transaction(() =>
      Effect.gen(function* changeEffect() {
        if (request.action?._tag === "RunPrompt") {
          const [current] = yield* database
            .select({ action: schedules.action })
            .from(schedules)
            .where(
              and(
                eq(schedules.ownerId, ownerId),
                eq(schedules.scheduleId, request.scheduleId),
                eq(schedules.state, "active")
              )
            );
          if (current !== undefined && current.action !== "run_prompt") {
            yield* requireRoomForScheduledTask(
              request.activeScheduledTaskLimit
            );
          }
        }
        const changed = yield* updateActive(request.scheduleId, {
          ...(request.action === undefined
            ? {}
            : columnsOfAction(request.action)),
          ...(request.dueAt === undefined
            ? {}
            : {
                nextDueAt: DateTime.formatIso(request.dueAt),
                ...recurrenceValuesOf(request.repeat),
              }),
        });
        if (Option.isSome(changed)) {
          yield* journal.append({
            _tag: "ScheduleChanged",
            eventId: request.eventId,
            scheduleId: request.scheduleId,
          });
        }
        return changed;
      })
    );

  const cancel = (request: ScheduleCancelRequest) =>
    database.transaction(() =>
      Effect.gen(function* cancelEffect() {
        const cancelled = yield* updateActive(request.scheduleId, {
          state: "cancelled",
        });
        if (Option.isSome(cancelled)) {
          yield* journal.append({
            _tag: "ScheduleCancelled",
            eventId: request.eventId,
            scheduleId: request.scheduleId,
          });
        }
        return cancelled;
      })
    );

  return {
    listActive,
    change,
    cancel,
    requireRoomForScheduledTask,
  };
});
