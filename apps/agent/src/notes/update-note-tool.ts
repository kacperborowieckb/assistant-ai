import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { noteIdListSchema } from "./note-id-list-schema.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import {
  openLoopForModel,
  openLoopLocalDueTimeSchema,
  resolveOpenLoopDue,
} from "./open-loop-presentation.ts";
import type { OpenLoopToolServices } from "./open-loop-tool-services.ts";
import { textForModel } from "./recalled-note.ts";

export const updateNoteToolName = "update_note";

export const noteNotUpdatedMessage =
  "The Note was not updated. Tell the Owner that you could not change it.";

export const nothingToUpdateMessage =
  "The Note was not updated. Give new text, Notes to link, or Notes to unlink, or give an Open Loop.";

export const openLoopNeedsKindMessage =
  "The Note has no open Open Loop, so nothing was changed. Give the kind of the Open Loop to open one.";

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
    Schema.Struct({
      kind: Schema.optionalKey(
        Schema.String.pipe(
          Schema.check(Schema.isPattern(/\S/u)),
          Schema.annotate({
            description:
              'What kind of thing to come back to, for example "task". Needed to open an Open Loop on a Note that has none open.',
          })
        )
      ),
      localDueTime: Schema.optionalKey(openLoopLocalDueTimeSchema),
    }).pipe(
      Schema.annotate({
        description:
          "Opens an Open Loop on this Note, or changes the kind or the due time of its open Open Loop. Use it when the Owner talks again about an old task that has no open Open Loop.",
      })
    )
  ),
});

export const updateNoteTool = (
  services: OpenLoopToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress: services.progress, redactor: services.redactor },
    {
      name: updateNoteToolName,
      description:
        "Change one existing Note after a follow-up of the Owner: replace its text, link or unlink other Notes, or open an Open Loop or change its due time. Creates no new Note. Search for the Note first when you do not know its id.",
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
        const dueAt = yield* resolveOpenLoopDue(
          services,
          openLoop?.localDueTime
        );
        const timeZone = yield* services.ownerTimeZone;
        const { note, linkedNoteIds: linked } = yield* services.notes
          .update({
            noteId,
            eventId,
            text,
            linkedNoteIds,
            unlinkedNoteIds,
            openLoop:
              openLoop === undefined
                ? undefined
                : { kind: openLoop.kind, dueAt },
          })
          .pipe(
            Effect.catchTag("OpenLoopNeedsKind", () =>
              Effect.fail(new ToolFailed({ message: openLoopNeedsKindMessage }))
            )
          );
        return {
          openLoop: openLoopForModel(note.openLoop, timeZone),
          noteId: note.noteId,
          text: textForModel(note),
          url: note.url ?? null,
          lastCheckedAt: note.lastCheckedAt,
          linkedNoteIds: linked,
        };
      }),
    }
  );
