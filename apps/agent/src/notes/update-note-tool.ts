import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { noteIdListSchema } from "./note-id-list-schema.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { OpenLoopInputSchema, openLoopRequestOf } from "./open-loop-input.ts";
import { openLoopForModel, textForModel } from "./recalled-note.ts";

export const updateNoteToolName = "update_note";

export const noteNotUpdatedMessage =
  "The Note was not updated. Tell the Owner that you could not change it.";

export const linkedAndUnlinkedMessage = (noteIds: readonly string[]) =>
  `The Note was not updated. The Note ids ${noteIds.join(", ")} are in both linkedNoteIds and unlinkedNoteIds. Give each id in one list only and call ${updateNoteToolName} again.`;

export const nothingToUpdateMessage =
  "The Note was not updated. Give new text, Notes to link, Notes to unlink, or an Open Loop.";

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
  openLoop: Schema.optionalKey(
    OpenLoopInputSchema.pipe(
      Schema.annotate({
        description:
          "The whole new Open Loop of the Note. It opens one when the Note has none, and replaces the kind and the due time of an open one. On a closed Open Loop it opens it again and clears its close reason, so give it only when the Owner takes the task up again. Leave out localDueTime only when it has no due date. To close an Open Loop, use close_open_loop.",
      })
    )
  ),
});

export const updateNoteTool = (
  { notes, ownerTimeZone, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: updateNoteToolName,
      description:
        "Change one existing Note after a follow-up of the Owner: replace its text, link or unlink other Notes, or open or change its Open Loop. Creates no new Note. Search for the Note first when you do not know its id.",
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
        openLoop,
      }) {
        if (
          text === undefined &&
          (linkedNoteIds ?? []).length === 0 &&
          (unlinkedNoteIds ?? []).length === 0 &&
          openLoop === undefined
        ) {
          return yield* new ToolFailed({ message: nothingToUpdateMessage });
        }
        const linkedAndUnlinked = (linkedNoteIds ?? []).filter((linkedId) =>
          (unlinkedNoteIds ?? []).includes(linkedId)
        );
        if (linkedAndUnlinked.length > 0) {
          return yield* new ToolFailed({
            message: linkedAndUnlinkedMessage(linkedAndUnlinked),
          });
        }
        const openLoopRequest = yield* openLoopRequestOf(
          openLoop,
          ownerTimeZone,
          { toolName: updateNoteToolName, consequence: "Nothing was changed." }
        );
        const { note, linkedNoteIds: linked } = yield* notes.update({
          noteId,
          eventId,
          text,
          linkedNoteIds,
          unlinkedNoteIds,
          openLoop: openLoopRequest,
        });
        return {
          noteId: note.noteId,
          text: textForModel(note),
          url: note.url ?? null,
          lastCheckedAt: note.lastCheckedAt,
          linkedNoteIds: linked,
          openLoop: openLoopForModel(note, yield* ownerTimeZone),
        };
      }),
    }
  );
