import { Effect, Schema } from "effect";

import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { maxLinkedNotesPerMatch } from "./note-links.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import type { RecalledNote } from "./notes.ts";
import { recalledNote } from "./recalled-note.ts";
import type { OwnerTimeZone } from "./recalled-note.ts";

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

const foundNote = (note: RecalledNote, timeZone: OwnerTimeZone) => ({
  ...recalledNote(note, timeZone),
  lastCheckedAt: note.lastCheckedAt,
  linkedNotes: note.linkedNotes.map((linked) => recalledNote(linked, timeZone)),
  linkedNoteCount: note.linkedNoteCount,
});

export const searchNotesTool = (
  { notes, ownerTimeZone, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: searchNotesToolName,
      description: `Search the Owner's Notes by keywords. Returns the best matches first, each with its source, captured date, Open Loop (null when it has none), and the newest linked Notes (at most ${maxLinkedNotesPerMatch}, with the total count). An empty list means that no Note matches.`,
      inputSchema: SearchNotesInput,
      failureMessage: notesNotSearchedMessage,
      work: ({ query, limit }) =>
        Effect.all({
          found: notes.search({ query, limit: limit ?? defaultSearchLimit }),
          timeZone: ownerTimeZone,
        }).pipe(
          Effect.map(({ found, timeZone }) => ({
            notes: found.map((note) => foundNote(note, timeZone)),
          }))
        ),
    }
  );
