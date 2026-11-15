import { and, eq, inArray } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { changeOfUpdate } from "./change-of-update.ts";
import { makeNoteLinks, uniqueNoteIds } from "./note-links.ts";
import { toNote } from "./note-row.ts";
import { hashOfNoteText } from "./note-text-hash.ts";
import type { NoteSource, NoteSourceLocation, TrustLevel } from "./note.ts";
import {
  bestMatchFirst,
  ftsMatchOf,
  matchesQuery,
  notesFts,
} from "./notes-fts.ts";

export interface Note {
  readonly noteId: string;
  readonly text: string;
  readonly url: string | undefined;
  readonly source: NoteSourceLocation;
  readonly trustLevel: TrustLevel;
  readonly capturedAt: string;
  readonly lastCheckedAt: string;
}

export interface CaptureRequest {
  readonly text: string;
  readonly url?: string | undefined;
  readonly source: NoteSource;
  readonly linkedNoteIds?: readonly string[] | undefined;
}

export interface UpdateRequest {
  readonly noteId: string;
  readonly eventId: string;
  readonly text?: string | undefined;
  readonly linkedNoteIds?: readonly string[] | undefined;
  readonly unlinkedNoteIds?: readonly string[] | undefined;
}

export interface RecalledNote extends Note {
  readonly linkedNotes: readonly Note[];
  readonly linkedNoteCount: number;
}

export interface SearchRequest {
  readonly query: string;
  readonly limit: number;
}

export interface Capture {
  readonly note: Note;
  readonly alreadyKept: boolean;
  readonly linkedNoteIds: readonly string[];
}

export interface Update {
  readonly note: Note;
  readonly linkedNoteIds: readonly string[];
}

const makeNotes = (ownerId: OwnerId) =>
  Effect.gen(function* makeNotesEffect() {
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;
    const {
      requireOwnNotes,
      linkedNoteIdsOf,
      linkedNotesOf,
      addLinks,
      removeLinks,
    } = yield* makeNoteLinks(ownerId);

    const journalCapture = (eventId: string, noteId: string) =>
      Effect.gen(function* journalCaptureEffect() {
        const entries = yield* journal.readForEvent(eventId);
        const alreadyJournaled = entries.some(
          (entry) =>
            entry.record._tag === "NoteCaptured" &&
            entry.record.noteId === noteId
        );
        if (!alreadyJournaled) {
          yield* journal.append({ _tag: "NoteCaptured", eventId, noteId });
        }
      });

    const writeNote = (
      { text, url, source, linkedNoteIds }: CaptureRequest,
      textHash: string
    ) =>
      Effect.gen(function* writeNoteEffect() {
        const now = new Date().toISOString();
        const [inserted] = yield* database
          .insert(notes)
          .values({
            noteId: crypto.randomUUID(),
            ownerId,
            text,
            url: url ?? null,
            sourceEventId: source.eventId,
            sourceChannel: source.channel,
            sourceConversationId: source.conversationId,
            sourceChannelMessageId: source.channelMessageId,
            sourceForwardOrigin: source.forwardOrigin ?? null,
            trustLevel: source.trustLevel,
            textHash,
            capturedAt: now,
            lastCheckedAt: now,
          })
          .onConflictDoNothing({
            target: [notes.sourceEventId, notes.textHash],
          })
          .returning();
        const [row] =
          inserted === undefined
            ? yield* database
                .select()
                .from(notes)
                .where(
                  and(
                    eq(notes.sourceEventId, source.eventId),
                    eq(notes.textHash, textHash)
                  )
                )
            : [inserted];
        if (row === undefined) {
          return yield* Effect.die("The Note is neither written nor found");
        }
        yield* journalCapture(source.eventId, row.noteId);
        if (inserted !== undefined) {
          yield* addLinks(row.noteId, uniqueNoteIds(linkedNoteIds));
        }
        return {
          note: toNote(row),
          alreadyKept: inserted === undefined,
          linkedNoteIds: yield* linkedNoteIdsOf(row.noteId),
        } satisfies Capture;
      });

    const capture = (request: CaptureRequest) =>
      hashOfNoteText(request.text).pipe(
        Effect.flatMap((textHash) =>
          database.transaction(() =>
            requireOwnNotes(uniqueNoteIds(request.linkedNoteIds)).pipe(
              Effect.andThen(writeNote(request, textHash))
            )
          )
        )
      );

    const writeUpdate = Effect.fnUntraced(function* writeUpdate(
      request: UpdateRequest
    ) {
      const { noteId, eventId, text } = request;
      yield* requireOwnNotes([
        noteId,
        ...uniqueNoteIds(request.linkedNoteIds),
        ...uniqueNoteIds(request.unlinkedNoteIds),
      ]);
      const [row] = yield* database
        .update(notes)
        .set({
          lastCheckedAt: DateTime.formatIso(yield* DateTime.now),
          ...(text === undefined ? {} : { text }),
        })
        .where(and(eq(notes.ownerId, ownerId), eq(notes.noteId, noteId)))
        .returning();
      if (row === undefined) {
        return yield* Effect.die("The Note is not found after the check");
      }
      yield* addLinks(noteId, uniqueNoteIds(request.linkedNoteIds));
      yield* removeLinks(noteId, uniqueNoteIds(request.unlinkedNoteIds));
      yield* journal.append({
        _tag: "NoteUpdated",
        eventId,
        noteId,
        change: changeOfUpdate(request),
      });
      return {
        note: toNote(row),
        linkedNoteIds: yield* linkedNoteIdsOf(noteId),
      } satisfies Update;
    });

    const update = (request: UpdateRequest) =>
      database.transaction(() => writeUpdate(request));

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

    return { capture, update, search, listLinked };
  });

export class Notes extends Context.Service<
  Notes,
  Effect.Success<ReturnType<typeof makeNotes>>
>()("Notes") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Notes, makeNotes(ownerId));
}
