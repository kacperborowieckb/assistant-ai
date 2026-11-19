import { and, eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { makeNoteLinks } from "./note-links.ts";
import { toNote } from "./note-row.ts";
import { notes } from "./notes-schema.ts";

export const makeNoteRows = Effect.fnUntraced(function* makeNoteRows(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const { requireOwnNotes } = yield* makeNoteLinks(ownerId);

  const ownNote = Effect.fnUntraced(function* ownNote(noteId: string) {
    yield* requireOwnNotes([noteId]);
    const [row] = yield* database
      .select()
      .from(notes)
      .where(and(eq(notes.ownerId, ownerId), eq(notes.noteId, noteId)));
    if (row === undefined) {
      return yield* Effect.die("The Note is not found after the check");
    }
    return toNote(row);
  });

  const writeNoteColumns = Effect.fnUntraced(function* writeNoteColumns(
    noteId: string,
    columns: Partial<typeof notes.$inferInsert>
  ) {
    const [row] = yield* database
      .update(notes)
      .set({
        ...columns,
        lastCheckedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .where(and(eq(notes.ownerId, ownerId), eq(notes.noteId, noteId)))
      .returning();
    if (row === undefined) {
      return yield* Effect.die("The Note is not found after the check");
    }
    return toNote(row);
  });

  return { ownNote, writeNoteColumns };
});
