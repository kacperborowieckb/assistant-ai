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
  const { ownNote, changeNote } = yield* makeNoteRows(ownerId);
  const { journalOpenLoopChange } = yield* makeOpenLoopStore(ownerId);

  const writeUpdate = Effect.fnUntraced(function* writeUpdate(
    request: UpdateRequest
  ) {
    const { noteId, eventId } = request;
    const current = yield* ownNote(noteId);
    const requestedLinks = uniqueNoteIds(request.linkedNoteIds);
    const requestedUnlinks = uniqueNoteIds(request.unlinkedNoteIds);
    yield* requireOwnNotes([...requestedLinks, ...requestedUnlinks]);
    const linkedBefore = yield* linkedNoteIdsOf(noteId);
    const newLinks = requestedLinks.filter(
      (linkedId) => linkedId !== noteId && !linkedBefore.includes(linkedId)
    );
    const goneLinks = requestedUnlinks.filter((linkedId) =>
      linkedBefore.includes(linkedId)
    );
    const text =
      request.text === undefined || request.text === current.text
        ? undefined
        : request.text;
    const openLoopChange =
      request.openLoop === undefined
        ? undefined
        : openLoopChangeOf(current.openLoop, request.openLoop);
    const change = changeOfUpdate({
      textChanged: text !== undefined,
      linksChanged: newLinks.length + goneLinks.length > 0,
    });
    if (change === undefined && openLoopChange === undefined) {
      return { note: current, linkedNoteIds: linkedBefore } satisfies Update;
    }
    const note = yield* changeNote(noteId, {
      text,
      openLoop: openLoopChange?.openLoop,
    });
    yield* addLinks(noteId, newLinks);
    yield* removeLinks(noteId, goneLinks);
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
