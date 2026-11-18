import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { noteIdListSchema } from "./note-id-list-schema.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { textForModel } from "./recalled-note.ts";

export const updateNoteToolName = "update_note";

export const noteNotUpdatedMessage =
  "The Note was not updated. Tell the Owner that you could not change it.";

export const nothingToUpdateMessage =
  "The Note was not updated. Give new text, Notes to link, or Notes to unlink.";

const UpdateNoteInput = Schema.Struct({
  noteId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The id of the Note to change. Use an id that search_notes or capture_note returned.",
    })
  ),
  text: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(Schema.isPattern(/\S/u)),
      Schema.annotate({
        description:
          "The whole new text of the Note, with the follow-up of the Owner applied. It replaces the old text.",
      })
    )
  ),
  linkedNoteIds: Schema.optionalKey(
    noteIdListSchema("Note ids of existing Notes to link to this Note.")
  ),
  unlinkedNoteIds: Schema.optionalKey(
    noteIdListSchema("Note ids of Notes to unlink from this Note.")
  ),
});

export const updateNoteTool = (
  { notes, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: updateNoteToolName,
      description:
        "Change one existing Note after a follow-up of the Owner: replace its text, or link or unlink other Notes. Creates no new Note. Search for the Note first when you do not know its id.",
      inputSchema: UpdateNoteInput,
      failureMessage: (cause) =>
        noteToolFailureMessage(cause, {
          unknownNotesConsequence: "Nothing was changed.",
          otherwise: noteNotUpdatedMessage,
        }),
      work: Effect.fnUntraced(function* updateNoteEffect({
        noteId,
        text,
        linkedNoteIds,
        unlinkedNoteIds,
      }) {
        if (
          text === undefined &&
          (linkedNoteIds ?? []).length === 0 &&
          (unlinkedNoteIds ?? []).length === 0
        ) {
          return yield* new ToolFailed({ message: nothingToUpdateMessage });
        }
        const { note, linkedNoteIds: linked } = yield* notes.update({
          noteId,
          eventId,
          text,
          linkedNoteIds,
          unlinkedNoteIds,
        });
        return {
          noteId: note.noteId,
          text: textForModel(note),
          url: note.url ?? null,
          lastCheckedAt: note.lastCheckedAt,
          linkedNoteIds: linked,
        };
      }),
    }
  );
