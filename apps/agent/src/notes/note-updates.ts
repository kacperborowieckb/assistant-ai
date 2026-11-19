import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { changeOfUpdate } from "./change-of-update.ts";
import { makeNoteLinks, uniqueNoteIds } from "./note-links.ts";
import { makeNoteRows } from "./note-rows.ts";
import type { Note } from "./notes.ts";
import { openLoopChangeOf } from "./open-loop-change.ts";
import type { OpenLoopRequest } from "./open-loop-change.ts";
import { makeOpenLoopStore } from "./open-loop-store.ts";
import { columnsOfOpenLoop } from "./open-loop.ts";

export interface UpdateRequest {
  readonly noteId: string;
  readonly eventId: string;
  readonly text?: string | undefined;
  readonly linkedNoteIds?: readonly string[] | undefined;
  readonly unlinkedNoteIds?: readonly string[] | undefined;
  readonly openLoop?: OpenLoopRequest | undefined;
}

export interface Update {
  readonly note: Note;
  readonly linkedNoteIds: readonly string[];
}

export const makeNoteUpdates = Effect.fnUntraced(function* makeNoteUpdates(
  ownerId: OwnerId
) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;
  const { requireOwnNotes, linkedNoteIdsOf, addLinks, removeLinks } =
    yield* makeNoteLinks(ownerId);
  const { ownNote, writeNoteColumns } = yield* makeNoteRows(ownerId);
  const { journalOpenLoopChange } = yield* makeOpenLoopStore(ownerId);

  const writeUpdate = Effect.fnUntraced(function* writeUpdate(
    request: UpdateRequest
  ) {
    const { noteId, eventId, text } = request;
    yield* requireOwnNotes([
      noteId,
      ...uniqueNoteIds(request.linkedNoteIds),
      ...uniqueNoteIds(request.unlinkedNoteIds),
    ]);
    const current = yield* ownNote(noteId);
    const openLoopChange =
      request.openLoop === undefined
        ? undefined
        : openLoopChangeOf(current.openLoop, request.openLoop);
    const note = yield* writeNoteColumns(noteId, {
      ...(text === undefined ? {} : { text }),
      ...(openLoopChange === undefined
        ? {}
        : columnsOfOpenLoop(openLoopChange.openLoop)),
    });
    yield* addLinks(noteId, uniqueNoteIds(request.linkedNoteIds));
    yield* removeLinks(noteId, uniqueNoteIds(request.unlinkedNoteIds));
    const change = changeOfUpdate(request);
    if (change !== undefined) {
      yield* journal.append({ _tag: "NoteUpdated", eventId, noteId, change });
    }
    if (openLoopChange !== undefined) {
      yield* journalOpenLoopChange(eventId, noteId, openLoopChange);
    }
    return {
      note,
      linkedNoteIds: yield* linkedNoteIdsOf(noteId),
    } satisfies Update;
  });

  const update = (request: UpdateRequest) =>
    database.transaction(() => writeUpdate(request));

  return { update };
});
