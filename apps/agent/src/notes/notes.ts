import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { normalizeNoteText } from "./note.ts";
import type { NoteSource, TrustLevel } from "./note.ts";

export interface Note {
  readonly noteId: string;
  readonly text: string;
  readonly url: string | undefined;
  readonly trustLevel: TrustLevel;
  readonly capturedAt: string;
  readonly lastCheckedAt: string;
}

export interface CaptureRequest {
  readonly text: string;
  readonly url?: string | undefined;
  readonly source: NoteSource;
}

export interface Capture {
  readonly note: Note;
  readonly alreadyKept: boolean;
}

const toNote = (row: typeof notes.$inferSelect): Note => ({
  noteId: row.noteId,
  text: row.text,
  url: row.url ?? undefined,
  trustLevel: row.trustLevel,
  capturedAt: row.capturedAt,
  lastCheckedAt: row.lastCheckedAt,
});

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

    const keptForEvent = (eventId: string) =>
      database
        .select()
        .from(notes)
        .where(eq(notes.sourceEventId, eventId))
        .orderBy(asc(notes.capturedAt))
        .pipe(Effect.map((rows) => rows.map(toNote)));

    return { capture, keptForEvent };
  });

export class Notes extends Context.Service<
  Notes,
  Effect.Success<ReturnType<typeof makeNotes>>
>()("Notes") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Notes, makeNotes(ownerId));
}
