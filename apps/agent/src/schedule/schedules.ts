import { and, asc, eq, lte, notExists } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import { makeNoteLinks } from "../notes/note-links.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { inboxEvents, schedules } from "../personal-agent/storage-schema.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import { makeRepeatingSchedules } from "./repeating-schedules.ts";
import { makeScheduleEdits, recurrenceValuesOf } from "./schedule-edits.ts";
import { encodeRule, toSchedule } from "./schedule.ts";
import type { Repeat, Schedule } from "./schedule.ts";

export type { Schedule } from "./schedule.ts";

export interface SetScheduleRequest {
  readonly kind: Schedule["kind"];
  readonly setBy: Schedule["setBy"];
  readonly text: string;
  readonly noteId?: string | undefined;
  readonly dueAt: DateTime.Utc;
  readonly repeat?: Repeat | undefined;
  readonly sourceEventId: string;
}

export interface ScheduleSet {
  readonly schedule: Schedule;
  readonly alreadySet: boolean;
}

const requestKeyOf = ({ text, dueAt, noteId, repeat }: SetScheduleRequest) =>
  JSON.stringify([
    text,
    DateTime.formatIso(dueAt),
    noteId ?? null,
    repeat === undefined
      ? null
      : [encodeRule(repeat.rule), DateTime.zoneToString(repeat.timeZone)],
  ]);

const hasNoInboxEventForDueInstant = (
  database: AgentStorage["Service"]["database"]
) =>
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

const makeSchedules = Effect.fnUntraced(function* makeSchedules(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const { requireOwnNotes } = yield* makeNoteLinks(ownerId);
  const scheduleEdits = yield* makeScheduleEdits(ownerId);
  const repeatingSchedules = yield* makeRepeatingSchedules(ownerId);

  const writeSchedule = Effect.fnUntraced(function* writeSchedule(
    request: SetScheduleRequest
  ) {
    yield* requireOwnNotes(
      request.noteId === undefined ? [] : [request.noteId]
    );
    const requestKey = requestKeyOf(request);
    const now = DateTime.formatIso(yield* DateTime.now);
    const [inserted] = yield* database
      .insert(schedules)
      .values({
        scheduleId: crypto.randomUUID(),
        ownerId,
        kind: request.kind,
        setBy: request.setBy,
        text: request.text,
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
    if (inserted !== undefined) {
      yield* journal.append({
        _tag: "ScheduleSet",
        eventId: request.sourceEventId,
        scheduleId: inserted.scheduleId,
      });
      return { schedule: toSchedule(inserted), alreadySet: false };
    }
    const [existing] = yield* database
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.sourceEventId, request.sourceEventId),
          eq(schedules.requestKey, requestKey)
        )
      );
    if (existing === undefined) {
      return yield* Effect.die("The Schedule is neither written nor found");
    }
    return { schedule: toSchedule(existing), alreadySet: true };
  });

  const set = (request: SetScheduleRequest) =>
    database.transaction(() => writeSchedule(request));

  const byId = (scheduleId: string) =>
    database
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.ownerId, ownerId),
          eq(schedules.scheduleId, scheduleId)
        )
      )
      .pipe(
        Effect.map(([row]) =>
          Option.fromNullishOr(row).pipe(Option.map(toSchedule))
        )
      );

  const unfiredActive = and(
    eq(schedules.ownerId, ownerId),
    eq(schedules.state, "active"),
    hasNoInboxEventForDueInstant(database)
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

  const dueActive = (scheduleId: string, dueAt: string) =>
    and(
      eq(schedules.ownerId, ownerId),
      eq(schedules.scheduleId, scheduleId),
      eq(schedules.state, "active"),
      eq(schedules.nextDueAt, dueAt)
    );

  const complete = (scheduleId: string, dueAt: string, eventId: string) =>
    database.transaction(() =>
      Effect.gen(function* completeEffect() {
        const now = yield* DateTime.now;
        const [due] = yield* database
          .select()
          .from(schedules)
          .where(dueActive(scheduleId, dueAt));
        if (due === undefined) {
          return;
        }
        const { repeat } = toSchedule(due);
        if (repeat === undefined) {
          yield* database
            .update(schedules)
            .set({ state: "done", changedAt: DateTime.formatIso(now) })
            .where(dueActive(scheduleId, dueAt));
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
        yield* database
          .update(schedules)
          .set({
            nextDueAt: DateTime.formatIso(nextDueAt),
            changedAt: DateTime.formatIso(now),
          })
          .where(dueActive(scheduleId, dueAt));
        yield* journal.append({
          _tag: "ScheduleRescheduled",
          eventId,
          scheduleId,
          nextDueAt: DateTime.formatIso(nextDueAt),
        });
      })
    );

  return {
    ...scheduleEdits,
    ...repeatingSchedules,
    set,
    byId,
    earliestUnfiredDueAt,
    unfiredDueBy,
    complete,
  };
});

export class Schedules extends Context.Service<
  Schedules,
  Effect.Success<ReturnType<typeof makeSchedules>>
>()("Schedules") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Schedules, makeSchedules(ownerId));
}
