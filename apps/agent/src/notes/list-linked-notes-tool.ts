import { Effect, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { maxLinkedNotesPerMatch } from "./note-links.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { recalledNote } from "./recalled-note.ts";

export const listLinkedNotesToolName = "list_linked_notes";

export const linkedNotesNotListedMessage =
  "The linked Notes could not be listed. Tell the Owner that you could not look in your Notes.";

const ListLinkedNotesInput = Schema.Struct({
  noteId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The id of the Note whose linked Notes to list. Use an id that search_notes returned.",
    })
  ),
  offset: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.annotate({
        description: `How many of the newest linked Notes to skip. The default is 0. Use the number of Notes that you already have to get the next page of ${maxLinkedNotesPerMatch}.`,
      })
    )
  ),
});

export const listLinkedNotesTool = (
  { notes, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  agentTool({
    description: `List the Notes linked to one Note, newest link first, ${maxLinkedNotesPerMatch} at a time, with the total count. Use it when search_notes shows more linked Notes than it returned.`,
    inputSchema: effectInputSchema(ListLinkedNotesInput),
    execute: ({ noteId, offset }, { toolCallId, modelStepKey }) =>
      Effect.gen(function* listLinkedNotesEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        return yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: listLinkedNotesToolName,
            input: offset === undefined ? { noteId } : { noteId, offset },
            redactor,
          },
          notes.listLinked(noteId, offset ?? 0).pipe(
            Effect.map(({ linkedNotes, linkedNoteCount }) => ({
              linkedNotes: linkedNotes.map((linked) => recalledNote(linked)),
              linkedNoteCount,
            }))
          )
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new ToolFailed({
              message: noteToolFailureMessage(cause, {
                unknownNotesConsequence: "Nothing was listed.",
                otherwise: linkedNotesNotListedMessage,
              }),
            })
          )
        )
      ),
  });
