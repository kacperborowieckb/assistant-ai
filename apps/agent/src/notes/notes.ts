import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { changeOfUpdate } from "./change-of-update.ts";
import { makeNoteLinks, uniqueNoteIds } from "./note-links.ts";
import { makeNoteReads } from "./note-reads.ts";
import { toNote } from "./note-row.ts";
import { hashOfNoteText } from "./note-text-hash.ts";
import type { NoteSource, NoteSourceLocation, TrustLevel } from "./note.ts";
import { columnsOfOpenLoop, sameOpenLoop } from "./open-loop.ts";
import type {
  OpenLoop,
  OpenLoopRequest,
  OpenLoopUpdateRequest,
} from "./open-loop.ts";
import { makeOpenLoops } from "./open-loops.ts";

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
  readonly openLoop?: OpenLoopRequest | undefined;
  readonly source: NoteSource;
  readonly linkedNoteIds?: readonly string[] | undefined;
}

export interface UpdateRequest {
  readonly noteId: string;
  readonly eventId: string;
  readonly text?: string | undefined;
  readonly linkedNoteIds?: readonly string[] | undefined;
  readonly unlinkedNoteIds?: readonly string[] | undefined;
  readonly openLoop?: OpenLoopUpdateRequest | undefined;
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

export interface Update {
  readonly note: Note;
  readonly linkedNoteIds: readonly string[];
}

const makeNotes = (ownerId: OwnerId) =>
  Effect.gen(function* makeNotesEffect() {
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;
    const { requireOwnNotes, linkedNoteIdsOf, addLinks, removeLinks } =
      yield* makeNoteLinks(ownerId);
    const {
      rowOf,
      nextOpenLoop,
      journalOpenLoopOpened,
      closeOpenLoop,
      listOpenLoops,
    } = yield* makeOpenLoops(ownerId);

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
              openLoop === undefined
                ? undefined
                : { _tag: "Open", kind: openLoop.kind, dueAt: openLoop.dueAt }
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
            yield* journalOpenLoopOpened(source.eventId, row.noteId);
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

    const writeUpdate = Effect.fnUntraced(function* writeUpdate(
      request: UpdateRequest
    ) {
      const { noteId, eventId, text } = request;
      yield* requireOwnNotes([
        noteId,
        ...uniqueNoteIds(request.linkedNoteIds),
        ...uniqueNoteIds(request.unlinkedNoteIds),
      ]);
      const current = yield* rowOf(noteId);
      const currentLoop = toNote(current).openLoop;
      const loop =
        request.openLoop === undefined
          ? undefined
          : yield* nextOpenLoop(noteId, currentLoop, request.openLoop);
      const loopChanged =
        loop !== undefined &&
        (currentLoop === undefined || !sameOpenLoop(currentLoop, loop));
      const textOrLinksChanged =
        text !== undefined ||
        uniqueNoteIds(request.linkedNoteIds).length +
          uniqueNoteIds(request.unlinkedNoteIds).length >
          0;
      if (!textOrLinksChanged && !loopChanged) {
        return {
          note: toNote(current),
          linkedNoteIds: yield* linkedNoteIdsOf(noteId),
        } satisfies Update;
      }
      const [row] = yield* database
        .update(notes)
        .set({
          lastCheckedAt: DateTime.formatIso(yield* DateTime.now),
          ...(text === undefined ? {} : { text }),
          ...(loopChanged ? columnsOfOpenLoop(loop) : {}),
        })
        .where(and(eq(notes.ownerId, ownerId), eq(notes.noteId, noteId)))
        .returning();
      if (row === undefined) {
        return yield* Effect.die("The Note is not found after the check");
      }
      yield* addLinks(noteId, uniqueNoteIds(request.linkedNoteIds));
      yield* removeLinks(noteId, uniqueNoteIds(request.unlinkedNoteIds));
      if (textOrLinksChanged) {
        yield* journal.append({
          _tag: "NoteUpdated",
          eventId,
          noteId,
          change: changeOfUpdate(request),
        });
      }
      if (loopChanged) {
        yield* journal.append({
          _tag:
            currentLoop?._tag === "Open" ? "OpenLoopChanged" : "OpenLoopOpened",
          eventId,
          noteId,
        });
      }
      return {
        note: toNote(row),
        linkedNoteIds: yield* linkedNoteIdsOf(noteId),
      } satisfies Update;
    });

    const update = (request: UpdateRequest) =>
      database.transaction(() => writeUpdate(request));

    const { search, listLinked, list } = yield* makeNoteReads(ownerId);

    return {
      capture,
      update,
      closeOpenLoop,
      listOpenLoops,
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
