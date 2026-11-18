import { Context, DateTime, Effect, Layer, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import { makeNoteLinks } from "../notes/note-links.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import { columnsOfAction } from "./schedule-action.ts";
import { scheduleQueriesOf } from "./schedule-queries.ts";
import { recurrenceValuesOf, requestKeyOf } from "./schedule-requests.ts";
import type {
  AlarmClock,
  ScheduleCancelRequest,
  ScheduleChangeRequest,
  SetScheduleRequest,
} from "./schedule-requests.ts";
import { toSchedule } from "./schedule.ts";
import type { Schedule } from "./schedule.ts";

export type { Schedule } from "./schedule.ts";
export type {
  AlarmClock,
  ScheduleCancelRequest,
  ScheduleChangeRequest,
  ScheduleSet,
  SetScheduleRequest,
} from "./schedule-requests.ts";

const makeSchedules = Effect.fnUntraced(function* makeSchedules(
  ownerId: OwnerId,
  clock: AlarmClock
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const { requireOwnNotes } = yield* makeNoteLinks(ownerId);
  const {
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
  } = scheduleQueriesOf(database, ownerId);

  const writeSchedule = Effect.fnUntraced(function* writeSchedule(
    request: SetScheduleRequest
  ) {
    yield* requireOwnNotes(
      request.noteId === undefined ? [] : [request.noteId]
    );
    const requestKey = requestKeyOf(request);
    const alreadyStored = yield* findByRequest(
      request.sourceEventId,
      requestKey
    );
    if (alreadyStored !== undefined) {
      return { schedule: toSchedule(alreadyStored), alreadySet: true };
    }
    if (request.action._tag === "RunPrompt") {
      yield* requireRoomForScheduledTask(request.activeScheduledTaskLimit);
    }
    const inserted = yield* insertSchedule(request, requestKey);
    if (inserted !== undefined) {
      yield* journal.append({
        _tag: "ScheduleSet",
        eventId: request.sourceEventId,
        scheduleId: inserted.scheduleId,
      });
      return { schedule: toSchedule(inserted), alreadySet: false };
    }
    const existing = yield* findByRequest(request.sourceEventId, requestKey);
    if (existing === undefined) {
      return yield* Effect.die("The Schedule is neither written nor found");
    }
    return { schedule: toSchedule(existing), alreadySet: true };
  });

  const rearm = earliestUnfiredDueAt.pipe(
    Effect.flatMap((dueAt) => Effect.promise(() => clock.setAt(dueAt)))
  );

  // Every change that can move the earliest due instant commits first, then
  // moves the alarm.
  const rearmedTransaction = <A, E, R>(body: () => Effect.Effect<A, E, R>) =>
    database.transaction(body).pipe(Effect.tap(() => rearm));

  const set = (request: SetScheduleRequest) =>
    rearmedTransaction(() => writeSchedule(request));

  const complete = (scheduleId: string, dueAt: string, eventId: string) =>
    database
      .transaction(() =>
        Effect.gen(function* completeEffect() {
          const now = yield* DateTime.now;
          const [due] = yield* findDue(scheduleId, dueAt);
          if (due === undefined) {
            return;
          }
          const { repeat } = toSchedule(due);
          if (repeat === undefined) {
            yield* updateDue(scheduleId, dueAt, {
              state: "done",
              changedAt: DateTime.formatIso(now),
            });
            yield* journal.append({
              _tag: "ScheduleCompleted",
              eventId,
              scheduleId,
            });
            return;
          }
          const nextDueAt = nextOccurrence(
            repeat.rule,
            DateTime.max(DateTime.makeUnsafe(dueAt), now),
            repeat.timeZone
          );
          yield* updateDue(scheduleId, dueAt, {
            nextDueAt: DateTime.formatIso(nextDueAt),
            changedAt: DateTime.formatIso(now),
          });
          yield* journal.append({
            _tag: "ScheduleRescheduled",
            eventId,
            scheduleId,
            nextDueAt: DateTime.formatIso(nextDueAt),
          });
        })
      )
      .pipe(
        // The Schedule is already completed, so a failed alarm update must not
        // fail the delivery. The next alarm run or restart re-arms it.
        Effect.tap(() =>
          rearm.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("The alarm could not be re-armed", cause)
            )
          )
        )
      );

  const fireDueBy = <A, E, R>(
    now: DateTime.Utc,
    fire: (due: readonly Schedule[]) => Effect.Effect<A, E, R>
  ) =>
    unfiredDueBy(now).pipe(
      Effect.flatMap(fire),
      Effect.ensuring(rearm.pipe(Effect.orDie))
    );

  const change = (request: ScheduleChangeRequest) =>
    rearmedTransaction(() =>
      Effect.gen(function* changeEffect() {
        if (request.action?._tag === "RunPrompt") {
          const [current] = yield* findActive(request.scheduleId);
          if (
            current !== undefined &&
            toSchedule(current).action._tag !== "RunPrompt"
          ) {
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
    rearmedTransaction(() =>
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

  const moveRepeatingToTimeZone = (
    timeZone: DateTime.TimeZone.Named,
    eventId: string
  ) =>
    rearmedTransaction(() =>
      Effect.gen(function* moveEffect() {
        const now = yield* DateTime.now;
        const zoneName = DateTime.zoneToString(timeZone);
        const rows = yield* activeRepeatingOutsideZone(zoneName);
        for (const row of rows) {
          const { rule } = Option.getOrThrow(
            Option.fromNullishOr(toSchedule(row).repeat)
          );
          const nextDueAt = DateTime.formatIso(
            nextOccurrence(rule, now, timeZone)
          );
          yield* updateRow(row.scheduleId, {
            nextDueAt,
            recurrenceTimeZone: zoneName,
            changedAt: DateTime.formatIso(now),
          });
          yield* journal.append({
            _tag: "ScheduleChanged",
            eventId,
            scheduleId: row.scheduleId,
          });
        }
      })
    );

  // A new runtime (a restart or a deploy) puts the alarm back in line with the table.
  yield* rearm;

  return {
    listActive,
    set,
    change,
    cancel,
    moveRepeatingToTimeZone,
    requireRoomForScheduledTask,
    byId,
    fireDueBy,
    complete,
  };
});

export class Schedules extends Context.Service<
  Schedules,
  Effect.Success<ReturnType<typeof makeSchedules>>
>()("Schedules") {
  static readonly layer = (ownerId: OwnerId, clock: AlarmClock) =>
    Layer.effect(Schedules, makeSchedules(ownerId, clock));
}
