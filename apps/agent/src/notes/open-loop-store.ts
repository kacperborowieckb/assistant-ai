import { and, asc, count, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { NoOpenLoop } from "./no-open-loop.ts";
import { toNote } from "./note-row.ts";
import { makeNoteRows } from "./note-rows.ts";
import type { Note } from "./notes.ts";
import type { OpenLoopChange } from "./open-loop-change.ts";
import { columnsOfOpenLoop, dueAtOfOpenLoop } from "./open-loop.ts";
import type { OpenLoopClosedReason } from "./open-loop.ts";

export interface CloseOpenLoopRequest {
  readonly noteId: string;
  readonly eventId: string;
  readonly reason: OpenLoopClosedReason;
}

export interface OpenLoopClose {
  readonly note: Note;
  readonly alreadyClosed: boolean;
}

export interface OpenLoopPageRequest {
  readonly offset: number;
  readonly limit: number;
}

export interface OpenLoopPage {
  readonly notes: readonly Note[];
  readonly openLoopCount: number;
}

const isOpenLoopOpen = eq(notes.openLoopState, "open");

const dueFirst = [
  asc(isNull(notes.openLoopDueAt)),
  asc(notes.openLoopDueAt),
  asc(notes.capturedAt),
  asc(notes.noteId),
];

export const makeOpenLoopStore = Effect.fnUntraced(function* makeOpenLoopStore(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const { ownNote, changeNote } = yield* makeNoteRows(ownerId);

  const journalOpenLoopChange = (
    eventId: string,
    noteId: string,
    { openLoop, record }: OpenLoopChange
  ) =>
    journal.append({
      _tag: record,
      eventId,
      noteId,
      kind: openLoop.kind,
      dueAt: dueAtOfOpenLoop(openLoop),
    });

  const closedInEvent = (eventId: string, noteId: string) =>
    journal
      .readForEvent(eventId)
      .pipe(
        Effect.map((entries) =>
          entries.some(
            (entry) =>
              entry.record._tag === "OpenLoopClosed" &&
              entry.record.noteId === noteId
          )
        )
      );

  const writeClose = Effect.fnUntraced(function* writeClose({
    noteId,
    eventId,
    reason,
  }: CloseOpenLoopRequest) {
    const current = yield* ownNote(noteId);
    const { openLoop } = current;
    if (
      openLoop?._tag === "Closed" &&
      (yield* closedInEvent(eventId, noteId))
    ) {
      return { note: current, alreadyClosed: true } satisfies OpenLoopClose;
    }
    if (openLoop?._tag !== "Open") {
      return yield* new NoOpenLoop({ noteId });
    }
    const note = yield* changeNote(
      noteId,
      columnsOfOpenLoop({ ...openLoop, _tag: "Closed", reason })
    );
    yield* journal.append({
      _tag: "OpenLoopClosed",
      eventId,
      noteId,
      reason,
    });
    return { note, alreadyClosed: false } satisfies OpenLoopClose;
  });

  const closeOpenLoop = (request: CloseOpenLoopRequest) =>
    database.transaction(() => writeClose(request));

  const listOpenLoops = ({ offset, limit }: OpenLoopPageRequest) =>
    Effect.all({
      rows: database
        .select()
        .from(notes)
        .where(and(eq(notes.ownerId, ownerId), isOpenLoopOpen))
        .orderBy(...dueFirst)
        .limit(limit)
        .offset(offset),
      counted: database
        .select({ openLoops: count() })
        .from(notes)
        .where(and(eq(notes.ownerId, ownerId), isOpenLoopOpen)),
    }).pipe(
      Effect.map(({ rows, counted: [counted] }): OpenLoopPage => ({
        notes: rows.map(toNote),
        openLoopCount: counted?.openLoops ?? 0,
      }))
    );

  return { journalOpenLoopChange, closeOpenLoop, listOpenLoops };
});
