import { DateTime, Effect, Layer, Option, Context } from "effect";

import { Journal } from "../journal/journal.ts";
import { makeNoteLinks } from "../notes/note-links.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import { columnsOfAction } from "./schedule-action.ts";
import { makeScheduleMoves } from "./schedule-moves.ts";
import { makeScheduleQueries } from "./schedule-queries.ts";
import { recurrenceValuesOf, requestKeyOf, toSchedule } from "./schedule.ts";
import type {
  Schedule,
  ScheduleCancelRequest,
  ScheduleChangeRequest,
  SetScheduleRequest,
} from "./schedule.ts";

export type {
  Schedule,
  ScheduleCancelRequest,
  ScheduleChangeRequest,
  ScheduleSet,
  SetScheduleRequest,
} from "./schedule.ts";

export interface AlarmClock {
  readonly setAt: (dueAt: Option.Option<DateTime.Utc>) => Promise<void>;
}

const makeSchedules = Effect.fnUntraced(function* makeSchedules(
  ownerId: OwnerId,
  clock: AlarmClock
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const { requireOwnNotes } = yield* makeNoteLinks(ownerId);
  const queries = yield* makeScheduleQueries(ownerId);
  const { requireRoomForScheduledTask } = queries;

  const rearm = queries.earliestAlarmAt.pipe(
    Effect.flatMap((dueAt) => Effect.promise(() => clock.setAt(dueAt)))
  );

  const rearmWithoutFailing = rearm.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("The alarm was not moved to the earliest Schedule", cause)
    )
  );

  const rearmedTransaction = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    database.transaction(() =>
      work.pipe(Effect.tap(() => rearmWithoutFailing))
    );

  const writeSchedule = Effect.fnUntraced(function* writeSchedule(
    request: SetScheduleRequest
  ) {
    yield* requireOwnNotes(
      request.noteId === undefined ? [] : [request.noteId]
    );
    const requestKey = requestKeyOf(request);
    const alreadyStored = yield* queries.findByRequest(
      request.sourceEventId,
      requestKey
    );
    if (Option.isSome(alreadyStored)) {
      return {
        schedule: toSchedule(alreadyStored.value),
        alreadySet: true,
      };
    }
    if (request.action._tag === "RunPrompt") {
      yield* requireRoomForScheduledTask(request.activeScheduledTaskLimit);
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* queries.insert({
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
    });
    if (Option.isSome(inserted)) {
      yield* journal.append({
        _tag: "ScheduleSet",
        eventId: request.sourceEventId,
        scheduleId: inserted.value.scheduleId,
      });
      return { schedule: toSchedule(inserted.value), alreadySet: false };
    }
    const existing = yield* queries.findByRequest(
      request.sourceEventId,
      requestKey
    );
    if (Option.isNone(existing)) {
      return yield* Effect.die("The Schedule is neither written nor found");
    }
    return { schedule: toSchedule(existing.value), alreadySet: true };
  });

  const set = (request: SetScheduleRequest) =>
    rearmedTransaction(writeSchedule(request));

  const changeActive = Effect.fnUntraced(function* changeActive(
    request: ScheduleChangeRequest
  ) {
    if (request.action?._tag === "RunPrompt") {
      const current = yield* queries.activeRowById(request.scheduleId);
      if (
        Option.isSome(current) &&
        toSchedule(current.value).action._tag !== "RunPrompt"
      ) {
        yield* requireRoomForScheduledTask(request.activeScheduledTaskLimit);
      }
    }
    const changed = yield* queries.updateActive(request.scheduleId, {
      changedAt: DateTime.formatIso(yield* DateTime.now),
      ...(request.action === undefined ? {} : columnsOfAction(request.action)),
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
    return changed.pipe(Option.map(toSchedule));
  });

  const change = (request: ScheduleChangeRequest) =>
    rearmedTransaction(changeActive(request));

  const cancelActive = Effect.fnUntraced(function* cancelActive(
    request: ScheduleCancelRequest
  ) {
    const cancelled = yield* queries.updateActive(request.scheduleId, {
      state: "cancelled",
      changedAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (Option.isSome(cancelled)) {
      yield* journal.append({
        _tag: "ScheduleCancelled",
        eventId: request.eventId,
        scheduleId: request.scheduleId,
      });
    }
    return cancelled.pipe(Option.map(toSchedule));
  });

  const cancel = (request: ScheduleCancelRequest) =>
    rearmedTransaction(cancelActive(request));

  const completeDue = Effect.fnUntraced(function* completeDue(
    scheduleId: string,
    dueAt: string,
    eventId: string
  ) {
    const now = yield* DateTime.now;
    const due = yield* queries.dueRowById(scheduleId, dueAt);
    if (Option.isNone(due)) {
      return;
    }
    const { repeat } = toSchedule(due.value);
    if (repeat === undefined) {
      yield* queries.updateDue(scheduleId, dueAt, {
        state: "done",
        changedAt: DateTime.formatIso(now),
      });
      yield* journal.append({ _tag: "ScheduleCompleted", eventId, scheduleId });
      return;
    }
    const nextDueAt = DateTime.formatIso(
      nextOccurrence(
        repeat.rule,
        DateTime.max(DateTime.makeUnsafe(dueAt), now),
        repeat.timeZone
      )
    );
    yield* queries.updateDue(scheduleId, dueAt, {
      nextDueAt,
      changedAt: DateTime.formatIso(now),
    });
    yield* journal.append({
      _tag: "ScheduleRescheduled",
      eventId,
      scheduleId,
      nextDueAt,
    });
  });

  const complete = (scheduleId: string, dueAt: string, eventId: string) =>
    rearmedTransaction(completeDue(scheduleId, dueAt, eventId));

  const { hold, moveRepeatingToTimeZone } = makeScheduleMoves(
    queries,
    journal,
    rearmedTransaction
  );

  const fireDue = <E, R>(
    handOff: (due: readonly Schedule[]) => Effect.Effect<void, E, R>
  ) =>
    Effect.gen(function* fireDueEffect() {
      const due = yield* queries.unfiredDueBy(yield* DateTime.now);
      yield* handOff(due);
      yield* rearm;
    });

  return {
    listActive: queries.listActive,
    byId: queries.byId,
    agentPromptScheduleId: queries.agentPromptScheduleId,
    requireRoomForScheduledTask,
    set,
    change,
    cancel,
    complete,
    hold,
    moveRepeatingToTimeZone,
    fireDue,
  };
});

export class Schedules extends Context.Service<
  Schedules,
  Effect.Success<ReturnType<typeof makeSchedules>>
>()("Schedules") {
  static readonly layer = (ownerId: OwnerId, clock: AlarmClock) =>
    Layer.effect(Schedules, makeSchedules(ownerId, clock));
}
