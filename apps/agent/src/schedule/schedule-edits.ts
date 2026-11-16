import { and, asc, eq } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { schedules } from "../personal-agent/storage-schema.ts";
import { toSchedule } from "./schedule.ts";
import type { Schedule } from "./schedule.ts";

export interface ScheduleChangeRequest {
  readonly scheduleId: string;
  readonly kind: Schedule["kind"];
  readonly text?: string | undefined;
  readonly dueAt?: DateTime.Utc | undefined;
  readonly eventId: string;
}

export interface ScheduleCancelRequest {
  readonly scheduleId: string;
  readonly kind: Schedule["kind"];
  readonly eventId: string;
}

interface ScheduleEditValues {
  readonly text?: string;
  readonly nextDueAt?: string;
  readonly state?: "cancelled";
}

export const makeScheduleEdits = Effect.fnUntraced(function* makeScheduleEdits(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const listActive = (kind: Schedule["kind"]) =>
    database
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.ownerId, ownerId),
          eq(schedules.kind, kind),
          eq(schedules.state, "active")
        )
      )
      .orderBy(asc(schedules.nextDueAt), asc(schedules.createdAt))
      .pipe(Effect.map((rows) => rows.map(toSchedule)));

  const updateActive = Effect.fnUntraced(function* updateActive(
    { scheduleId, kind }: Pick<ScheduleChangeRequest, "kind" | "scheduleId">,
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
          eq(schedules.kind, kind),
          eq(schedules.state, "active")
        )
      )
      .returning();
    return Option.fromNullishOr(row).pipe(Option.map(toSchedule));
  });

  const change = (request: ScheduleChangeRequest) =>
    database.transaction(() =>
      Effect.gen(function* changeEffect() {
        const changed = yield* updateActive(request, {
          ...(request.text === undefined ? {} : { text: request.text }),
          ...(request.dueAt === undefined
            ? {}
            : { nextDueAt: DateTime.formatIso(request.dueAt) }),
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
        const cancelled = yield* updateActive(request, { state: "cancelled" });
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

  return { listActive, change, cancel };
});
