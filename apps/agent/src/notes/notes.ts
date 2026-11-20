import { and, asc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { makeNoteLinks, uniqueNoteIds } from "./note-links.ts";
import { toNote } from "./note-row.ts";
import { hashOfNoteText } from "./note-text-hash.ts";
import { makeNoteUpdates } from "./note-updates.ts";
import type { NoteSource, NoteSourceLocation, TrustLevel } from "./note.ts";
import {
  bestMatchFirst,
  ftsMatchOf,
  matchesQuery,
  notesFts,
} from "./notes-fts.ts";
import { openOpenLoopOf } from "./open-loop-change.ts";
import type { OpenLoopRequest } from "./open-loop-change.ts";
import { makeOpenLoopStore } from "./open-loop-store.ts";
import { columnsOfOpenLoop } from "./open-loop.ts";
import type { OpenLoop } from "./open-loop.ts";

export interface Note {
  readonly noteId: string;
  readonly text: string;
  readonly url: string | undefined;
  readonly source: NoteSourceLocation;
  readonly trustLevel: TrustLevel;
  readonly capturedAt: string;
  readonly lastCheckedAt: string;
  readonly openLoop: OpenLoop | undefined;
}

export interface CaptureRequest {
  readonly text: string;
  readonly url?: string | undefined;
  readonly source: NoteSource;
  readonly linkedNoteIds?: readonly string[] | undefined;
  readonly openLoop?: OpenLoopRequest | undefined;
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

export interface ListedNote extends Note {
  readonly linkedNoteIds: readonly string[];
}

const makeNotes = (ownerId: OwnerId) =>
  Effect.gen(function* makeNotesEffect() {
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;
    const { requireOwnNotes, linkedNoteIdsOf, linkedNotesOf, addLinks } =
      yield* makeNoteLinks(ownerId);
    const {
      journalOpenLoopChange,
      closeOpenLoop,
      listOpenLoops,
      openLoopsAmong,
    } = yield* makeOpenLoopStore(ownerId);
    const { update } = yield* makeNoteUpdates(ownerId);

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
      { text, url, source, linkedNoteIds, openLoop }: CaptureRequest,
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
            ...columnsOfOpenLoop(
              openLoop === undefined ? undefined : openOpenLoopOf(openLoop)
            ),
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
          if (openLoop !== undefined) {
            yield* journalOpenLoopChange(source.eventId, row.noteId, {
              openLoop: openOpenLoopOf(openLoop),
              record: "OpenLoopOpened",
            });
          }
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

    const byIds = Effect.fnUntraced(function* byIds(
      noteIds: readonly string[]
    ) {
      if (noteIds.length === 0) {
        return [];
      }
      const rows = yield* database
        .select()
        .from(notes)
        .where(and(eq(notes.ownerId, ownerId), inArray(notes.noteId, noteIds)));
      return noteIds.flatMap((noteId) => {
        const row = rows.find((candidate) => candidate.noteId === noteId);
        return row === undefined ? [] : [toNote(row)];
      });
    });

    return {
      capture,
      update,
      byIds,
      closeOpenLoop,
      listOpenLoops,
      openLoopsAmong,
      search,
      listLinked,
      list,
    };
  });

export class Notes extends Context.Service<
  Notes,
  Effect.Success<ReturnType<typeof makeNotes>>
>()("Notes") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Notes, makeNotes(ownerId));
}
