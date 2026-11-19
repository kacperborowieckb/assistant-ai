import { and, eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { toNote } from "./note-row.ts";
import type { columnsOfOpenLoop } from "./open-loop.ts";
import { UnknownNotes } from "./unknown-notes.ts";

export type NoteChange = { readonly text?: string } & Partial<
  ReturnType<typeof columnsOfOpenLoop>
>;

export const makeNoteRows = Effect.fnUntraced(function* makeNoteRows(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;

  const isOwnNote = (noteId: string) =>
    and(eq(notes.ownerId, ownerId), eq(notes.noteId, noteId));

  const ownNote = Effect.fnUntraced(function* ownNote(noteId: string) {
    const [row] = yield* database.select().from(notes).where(isOwnNote(noteId));
    if (row === undefined) {
      return yield* new UnknownNotes({ noteIds: [noteId] });
    }
    return toNote(row);
  });

  const changeNote = Effect.fnUntraced(function* changeNote(
    noteId: string,
    change: NoteChange
  ) {
    const [row] = yield* database
      .update(notes)
      .set({
        ...change,
        lastCheckedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .where(isOwnNote(noteId))
      .returning();
    if (row === undefined) {
      return yield* Effect.die("The Note is not found after the check");
    }
    return toNote(row);
  });

  return { ownNote, changeNote };
});
