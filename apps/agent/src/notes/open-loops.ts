import { and, asc, count, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { NoOpenLoop } from "./no-open-loop.ts";
import { makeNoteLinks } from "./note-links.ts";
import { toNote } from "./note-row.ts";
import type { Note } from "./notes.ts";
import { OpenLoopNeedsKind } from "./open-loop-needs-kind.ts";
import { columnsOfOpenLoop, maxOpenLoopsPerPage } from "./open-loop.ts";
import type {
  CloseOpenLoopRequest,
  OpenLoop,
  OpenLoopUpdateRequest,
} from "./open-loop.ts";

export interface OpenLoopPage {
  readonly notes: readonly Note[];
  readonly openLoopCount: number;
}

export const makeOpenLoops = Effect.fnUntraced(function* makeOpenLoops(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const { requireOwnNotes } = yield* makeNoteLinks(ownerId);

  const journalOpenLoopOpened = (eventId: string, noteId: string) =>
    Effect.gen(function* journalOpenLoopOpenedEffect() {
      const entries = yield* journal.readForEvent(eventId);
      const alreadyJournaled = entries.some(
        (entry) =>
          entry.record._tag === "OpenLoopOpened" &&
          entry.record.noteId === noteId
      );
      if (!alreadyJournaled) {
        yield* journal.append({ _tag: "OpenLoopOpened", eventId, noteId });
      }
    });

  const rowOf = Effect.fnUntraced(function* rowOf(noteId: string) {
    const [row] = yield* database
      .select()
      .from(notes)
      .where(and(eq(notes.ownerId, ownerId), eq(notes.noteId, noteId)));
    if (row === undefined) {
      return yield* Effect.die("The Note is not found after the check");
    }
    return row;
  });

  const nextOpenLoop = Effect.fnUntraced(function* nextOpenLoop(
    noteId: string,
    current: OpenLoop | undefined,
    request: OpenLoopUpdateRequest
  ) {
    if (current?._tag === "Open") {
      return {
        _tag: "Open",
        kind: request.kind ?? current.kind,
        dueAt: request.dueAt ?? current.dueAt,
      } satisfies OpenLoop;
    }
    if (request.kind === undefined) {
      return yield* new OpenLoopNeedsKind({ noteId });
    }
    return {
      _tag: "Open",
      kind: request.kind,
      dueAt: request.dueAt,
    } satisfies OpenLoop;
  });

  const closeOpenLoop = ({ noteId, eventId, reason }: CloseOpenLoopRequest) =>
    database.transaction(() =>
      Effect.gen(function* closeOpenLoopEffect() {
        yield* requireOwnNotes([noteId]);
        const loop = toNote(yield* rowOf(noteId)).openLoop;
        if (loop?._tag !== "Open") {
          return yield* new NoOpenLoop({ noteId });
        }
        const [row] = yield* database
          .update(notes)
          .set(
            columnsOfOpenLoop({
              _tag: "Closed",
              kind: loop.kind,
              dueAt: loop.dueAt,
              reason,
            })
          )
          .where(and(eq(notes.ownerId, ownerId), eq(notes.noteId, noteId)))
          .returning();
        if (row === undefined) {
          return yield* Effect.die("The Note is not found after the close");
        }
        yield* journal.append({
          _tag: "OpenLoopClosed",
          eventId,
          noteId,
          reason,
        });
        return { note: toNote(row) };
      })
    );

  const listOpenLoops = Effect.fnUntraced(function* listOpenLoops(
    offset: number
  ) {
    const isOpen = and(
      eq(notes.ownerId, ownerId),
      eq(notes.openLoopState, "open")
    );
    const [total] = yield* database
      .select({ openLoopCount: count() })
      .from(notes)
      .where(isOpen);
    const rows = yield* database
      .select()
      .from(notes)
      .where(isOpen)
      .orderBy(
        asc(isNull(notes.openLoopDueAt)),
        asc(notes.openLoopDueAt),
        asc(notes.capturedAt),
        asc(notes.noteId)
      )
      .limit(maxOpenLoopsPerPage)
      .offset(offset);
    return {
      notes: rows.map((row) => toNote(row)),
      openLoopCount: total?.openLoopCount ?? 0,
    } satisfies OpenLoopPage;
  });

  return {
    rowOf,
    nextOpenLoop,
    journalOpenLoopOpened,
    closeOpenLoop,
    listOpenLoops,
  };
});
