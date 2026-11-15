import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { normalizeNoteText } from "./note.ts";
import type { NoteSource, NoteSourceLocation, TrustLevel } from "./note.ts";
import { bestMatchFirst, matchesQuery, notesFts } from "./notes-fts.ts";

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
}

export interface SearchRequest {
  readonly query: string;
  readonly limit: number;
}

export interface Capture {
  readonly note: Note;
  readonly alreadyKept: boolean;
}

const toNote = (row: typeof notes.$inferSelect): Note => ({
  noteId: row.noteId,
  text: row.text,
  url: row.url ?? undefined,
  source: {
    channel: row.sourceChannel,
    conversationId: row.sourceConversationId,
    channelMessageId: row.sourceChannelMessageId,
  },
  trustLevel: row.trustLevel,
  capturedAt: row.capturedAt,
  lastCheckedAt: row.lastCheckedAt,
});

const ftsMatchOf = (query: string) => {
  const words = query.match(/[\p{L}\p{N}]+/gu);
  return words === null
    ? undefined
    : words.map((word) => `"${word}"`).join(" OR ");
};

const hashOf = (text: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalizeNoteText(text))
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  });

const makeNotes = (ownerId: OwnerId) =>
  Effect.gen(function* makeNotesEffect() {
    const { database } = yield* AgentStorage;
    const journal = yield* Journal;

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
      { text, url, source }: CaptureRequest,
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
        return {
          note: toNote(row),
          alreadyKept: inserted === undefined,
        } satisfies Capture;
      });

    const capture = (request: CaptureRequest) =>
      hashOf(request.text).pipe(
        Effect.flatMap((textHash) =>
          database.transaction(() => writeNote(request, textHash))
        )
      );

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
      return noteIds.flatMap((noteId) => {
        const row = rows.find((candidate) => candidate.noteId === noteId);
        return row === undefined ? [] : [toNote(row)];
      });
    });

    return { capture, search };
  });

export class Notes extends Context.Service<
  Notes,
  Effect.Success<ReturnType<typeof makeNotes>>
>()("Notes") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Notes, makeNotes(ownerId));
}
