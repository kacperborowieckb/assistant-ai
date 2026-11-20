import { and, asc, count, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes, schedules } from "../personal-agent/storage-schema.ts";
import { ActiveAgentScheduleLimitReached } from "./active-agent-schedule-limit-reached.ts";
import { NotOpenLoops } from "./not-open-loops.ts";
import { scheduleOpenLoops } from "./schedule-open-loops-schema.ts";
import { toSchedule } from "./schedule.ts";

const linkBatchSize = 50;

export const makeScheduleOpenLoopLinks = Effect.fnUntraced(
  function* makeScheduleOpenLoopLinks(ownerId: OwnerId) {
    const { database } = yield* AgentStorage;

    const openLoopIdsBySchedule = Effect.fnUntraced(
      function* openLoopIdsBySchedule(scheduleIds: readonly string[]) {
        const grouped = new Map<string, string[]>();
        if (scheduleIds.length === 0) {
          return grouped;
        }
        for (
          let start = 0;
          start < scheduleIds.length;
          start += linkBatchSize
        ) {
          const links = yield* database
            .select()
            .from(scheduleOpenLoops)
            .where(
              inArray(
                scheduleOpenLoops.scheduleId,
                scheduleIds.slice(start, start + linkBatchSize)
              )
            )
            .orderBy(asc(scheduleOpenLoops.noteId));
          for (const link of links) {
            const group = grouped.get(link.scheduleId) ?? [];
            group.push(link.noteId);
            grouped.set(link.scheduleId, group);
          }
        }
        return grouped;
      }
    );

    const withOpenLoops = Effect.fnUntraced(function* withOpenLoops(
      rows: readonly (typeof schedules.$inferSelect)[]
    ) {
      const grouped = yield* openLoopIdsBySchedule(
        rows.map((row) => row.scheduleId)
      );
      return rows.map((row) => toSchedule(row, grouped.get(row.scheduleId)));
    });

    const insertOpenLoops = Effect.fnUntraced(function* insertOpenLoops(
      scheduleId: string,
      noteIds: readonly string[]
    ) {
      if (noteIds.length === 0) {
        return;
      }
      yield* database
        .insert(scheduleOpenLoops)
        .values(noteIds.map((noteId) => ({ scheduleId, noteId })))
        .onConflictDoNothing();
    });

    const countActiveAgentSchedules = database
      .select({ active: count() })
      .from(schedules)
      .where(
        and(
          eq(schedules.ownerId, ownerId),
          eq(schedules.setBy, "agent"),
          eq(schedules.state, "active")
        )
      )
      .pipe(Effect.map(([row]) => row?.active ?? 0));

    const requireRoomForAgentSchedule = Effect.fnUntraced(
      function* requireRoomForAgentSchedule(limit: number | undefined) {
        if (
          limit !== undefined &&
          (yield* countActiveAgentSchedules) >= limit
        ) {
          return yield* new ActiveAgentScheduleLimitReached({ limit });
        }
      }
    );

    const requireOpenLoops = Effect.fnUntraced(function* requireOpenLoops(
      noteIds: readonly string[]
    ) {
      if (noteIds.length === 0) {
        return;
      }
      const open = yield* database
        .select({ noteId: notes.noteId })
        .from(notes)
        .where(
          and(
            eq(notes.ownerId, ownerId),
            eq(notes.openLoopState, "open"),
            inArray(notes.noteId, [...noteIds])
          )
        );
      const openIds = new Set(open.map((row) => row.noteId));
      const closed = noteIds.filter((noteId) => !openIds.has(noteId));
      if (closed.length > 0) {
        return yield* new NotOpenLoops({ noteIds: closed });
      }
    });

    return {
      withOpenLoops,
      insertOpenLoops,
      requireOpenLoops,
      requireRoomForAgentSchedule,
    };
  }
);
