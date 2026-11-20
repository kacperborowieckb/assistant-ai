import { DateTime, Effect, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import { makeNoteLinks } from "../notes/note-links.ts";
import type { OwnerId } from "../owner-id.ts";
import { columnsOfAction } from "./schedule-action.ts";
import type { makeScheduleQueries } from "./schedule-queries.ts";
import { recurrenceValuesOf, requestKeyOf, toSchedule } from "./schedule.ts";
import type { ScheduleSet, SetScheduleRequest } from "./schedule.ts";

type ScheduleQueries = Effect.Success<ReturnType<typeof makeScheduleQueries>>;

export const makeWriteSchedule = Effect.fnUntraced(function* makeWriteSchedule(
  ownerId: OwnerId,
  queries: ScheduleQueries
) {
  const journal = yield* Journal;
  const { requireOwnNotes } = yield* makeNoteLinks(ownerId);

  const alreadySet = Effect.fnUntraced(function* alreadySet(
    row: Parameters<ScheduleQueries["withOpenLoops"]>[0][number]
  ) {
    const [schedule] = yield* queries.withOpenLoops([row]);
    return {
      schedule: Option.getOrThrow(Option.fromNullishOr(schedule)),
      alreadySet: true,
    } satisfies ScheduleSet;
  });

  return Effect.fnUntraced(function* writeSchedule(
    request: SetScheduleRequest
  ) {
    const openLoopIds = [...new Set(request.openLoopIds)];
    yield* requireOwnNotes(
      request.noteId === undefined
        ? openLoopIds
        : [request.noteId, ...openLoopIds]
    );
    const requestKey = requestKeyOf({ ...request, openLoopIds });
    const stored = yield* queries.findByRequest(
      request.sourceEventId,
      requestKey
    );
    if (Option.isSome(stored)) {
      return yield* alreadySet(stored.value);
    }
    yield* queries.requireOpenLoops(openLoopIds);
    if (request.setBy === "agent") {
      yield* queries.requireRoomForAgentSchedule(
        request.activeAgentScheduleLimit
      );
    } else if (request.action._tag === "RunPrompt") {
      yield* queries.requireRoomForScheduledTask(
        request.activeScheduledTaskLimit
      );
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
      yield* queries.insertOpenLoops(inserted.value.scheduleId, openLoopIds);
      yield* journal.append({
        _tag: "ScheduleSet",
        eventId: request.sourceEventId,
        scheduleId: inserted.value.scheduleId,
      });
      return {
        schedule: toSchedule(inserted.value, openLoopIds.toSorted()),
        alreadySet: false,
      } satisfies ScheduleSet;
    }
    const existing = yield* queries.findByRequest(
      request.sourceEventId,
      requestKey
    );
    if (Option.isNone(existing)) {
      return yield* Effect.die("The Schedule is neither written nor found");
    }
    return yield* alreadySet(existing.value);
  });
});
