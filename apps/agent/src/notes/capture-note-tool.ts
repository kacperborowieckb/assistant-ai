import { Effect, Schema } from "effect";

import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { noteIdListSchema } from "./note-id-list-schema.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import type { NoteSource } from "./note.ts";
import { textForModel } from "./recalled-note.ts";

export const captureNoteToolName = "capture_note";

export const noteNotKeptMessage =
  "The Note was not kept. Tell the Owner that you could not keep it.";

const CaptureNoteInput = Schema.Struct({
  text: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "What to keep, in the Owner's words. For a link, the comment.",
    })
  ),
  url: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(Schema.isPattern(/^https?:\/\/\S+$/u)),
      Schema.annotate({
        description: "The link to keep, when the Owner sent one.",
      })
    )
  ),
  linkedNoteIds: Schema.optionalKey(
    noteIdListSchema(
      "Note ids of existing Notes that this Note relates to. Use ids that search_notes or capture_note returned."
    )
  ),
});

export const captureNoteTool = (
  { notes, progress, redactor }: NoteToolServices,
  source: NoteSource
) =>
  recordedTool(
    { eventId: source.eventId, progress, redactor },
    {
      name: captureNoteToolName,
      description:
        "Keep a Note for the Owner at once: a task, a text, a link, or a text with a link. Call it without asking the Owner first. Does not open the link.",
      inputSchema: CaptureNoteInput,
      failureMessage: (cause) =>
        noteToolFailureMessage(cause, {
          unknownNotesConsequence: "Nothing was kept.",
          otherwise: noteNotKeptMessage,
        }),
      recordedInput: (input) => ({
        ...input,
        text: textForModel({
          text: source.forwardedText ?? input.text,
          trustLevel: source.trustLevel,
        }),
      }),
      work: ({ text, url, linkedNoteIds }) =>
        notes
          .capture({
            text: source.forwardedText ?? text,
            url,
            source,
            linkedNoteIds,
          })
          .pipe(
            Effect.map(({ note, alreadyKept, linkedNoteIds: linked }) => ({
              noteId: note.noteId,
              text: textForModel(note),
              url: note.url ?? null,
              alreadyKept,
              linkedNoteIds: linked,
            }))
          ),
    }
  );
