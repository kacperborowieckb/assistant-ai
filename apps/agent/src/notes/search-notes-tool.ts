import { Effect, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { markUntrustedContent } from "./note.ts";
import type { Note, RecalledNote } from "./notes.ts";

export const searchNotesToolName = "search_notes";

export const notesNotSearchedMessage =
  "The Notes could not be searched. Tell the Owner that you could not look in your Notes.";

export const defaultSearchLimit = 5;
export const maxSearchLimit = 20;

const SearchNotesInput = Schema.Struct({
  query: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "Keywords of the question, for example names, places, and topics.",
    })
  ),
  limit: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: maxSearchLimit })),
      Schema.annotate({
        description: `How many Notes to return at most. The default is ${defaultSearchLimit}.`,
      })
    )
  ),
});

const textOf = (note: Note) =>
  note.trustLevel === "untrusted" ? markUntrustedContent(note.text) : note.text;

const recalledNote = (note: Note) => ({
  noteId: note.noteId,
  text: textOf(note),
  url: note.url ?? null,
  source: {
    channel: note.source.channel,
    conversationId: note.source.conversationId,
    channelMessageId: note.source.channelMessageId,
  },
  trustLevel: note.trustLevel,
  capturedAt: note.capturedAt,
});

const foundNote = (note: RecalledNote) => ({
  ...recalledNote(note),
  lastCheckedAt: note.lastCheckedAt,
  linkedNotes: note.linkedNotes.map((linked) => recalledNote(linked)),
});

export const searchNotesTool = (
  { notes, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Search the Owner's Notes by keywords. Returns the best matches first, each with its source, captured date, and the Notes linked to it. An empty list means that no Note matches.",
    inputSchema: effectInputSchema(SearchNotesInput),
    execute: ({ query, limit }, { toolCallId, modelStepKey }) =>
      Effect.gen(function* searchNotesEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        return yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: searchNotesToolName,
            input: limit === undefined ? { query } : { query, limit },
            redactor,
          },
          notes
            .search({ query, limit: limit ?? defaultSearchLimit })
            .pipe(Effect.map((found) => ({ notes: found.map(foundNote) })))
        );
      }).pipe(
        Effect.catchCause(() =>
          Effect.fail(new ToolFailed({ message: notesNotSearchedMessage }))
        )
      ),
  });
