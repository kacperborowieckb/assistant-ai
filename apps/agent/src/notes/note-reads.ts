import { asc, and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { makeNoteLinks } from "./note-links.ts";
import { toNote } from "./note-row.ts";
import {
  bestMatchFirst,
  ftsMatchOf,
  matchesQuery,
  notesFts,
} from "./notes-fts.ts";
import type { ListedNote, SearchRequest } from "./notes.ts";

export const makeNoteReads = Effect.fnUntraced(function* makeNoteReads(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const { requireOwnNotes, linkedNoteIdsOf, linkedNotesOf } =
    yield* makeNoteLinks(ownerId);

  const listLinked = Effect.fnUntraced(function* listLinked(
    noteId: string,
    offset: number
  ) {
    yield* requireOwnNotes([noteId]);
    return yield* linkedNotesOf(noteId, offset);
  });

  const search = Effect.fnUntraced(function* search({
    query,
    limit,
  }: SearchRequest) {
    const match = ftsMatchOf(query);
    if (match === undefined) {
      return [];
    }
    const ranked = yield* database
      .select({ noteId: notesFts.noteId })
      .from(notesFts)
      .where(matchesQuery(match))
      .orderBy(bestMatchFirst)
      .limit(limit);
    const noteIds = ranked.map((row) => row.noteId);
    if (noteIds.length === 0) {
      return [];
    }
    const rows = yield* database
      .select()
      .from(notes)
      .where(and(eq(notes.ownerId, ownerId), inArray(notes.noteId, noteIds)));
    const recalled = noteIds.flatMap((noteId) => {
      const row = rows.find((candidate) => candidate.noteId === noteId);
      return row === undefined ? [] : [toNote(row)];
    });
    return yield* Effect.all(
      recalled.map((note) =>
        linkedNotesOf(note.noteId, 0).pipe(
          Effect.map((linked) => ({ ...note, ...linked }))
        )
      )
    );
  });

  const list = database
    .select()
    .from(notes)
    .where(eq(notes.ownerId, ownerId))
    .orderBy(asc(notes.capturedAt), asc(notes.noteId))
    .pipe(
      Effect.flatMap((rows) =>
        Effect.all(
          rows.map((row) =>
            linkedNoteIdsOf(row.noteId).pipe(
              Effect.map((linkedNoteIds): ListedNote => ({
                ...toNote(row),
                linkedNoteIds,
              }))
            )
          )
        )
      )
    );

  return { search, listLinked, list };
});
