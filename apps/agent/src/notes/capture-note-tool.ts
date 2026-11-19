import { Effect, Schema } from "effect";

import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { noteIdListSchema } from "./note-id-list-schema.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteSource } from "./note.ts";
import {
  kindForModel,
  openLoopForModel,
  openLoopLocalDueTimeSchema,
  resolveOpenLoopDue,
} from "./open-loop-presentation.ts";
import type { OpenLoopToolServices } from "./open-loop-tool-services.ts";
import { textForModel } from "./recalled-note.ts";

export const captureNoteToolName = "capture_note";

export const noteNotKeptMessage =
  "The Note was not kept. Tell the Owner that you could not keep it.";

const OpenLoopInput = Schema.Struct({
  kind: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        'What kind of thing to come back to, in one or two words, for example "task".',
    })
  ),
  localDueTime: Schema.optionalKey(openLoopLocalDueTimeSchema),
});

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
  openLoop: Schema.optionalKey(
    OpenLoopInput.pipe(
      Schema.annotate({
        description:
          "Give it when the Note is something to do or to come back to, such as a task. Leave it out for a fact.",
      })
    )
  ),
});

const keptTextOf = (source: NoteSource, text: string) =>
  source.forwardedText ?? text;

export const captureNoteTool = (
  services: OpenLoopToolServices,
  source: NoteSource
) =>
  recordedTool(
    {
      eventId: source.eventId,
      progress: services.progress,
      redactor: services.redactor,
    },
    {
      name: captureNoteToolName,
      description:
        "Keep a Note for the Owner at once: a task, a text, a link, or a text with a link. Call it without asking the Owner first. Does not open the link. Give openLoop when the Note is something to do or to come back to; it opens an Open Loop with a kind and an optional local due time. A fact gets no openLoop.",
      inputSchema: CaptureNoteInput,
      failureMessage: (cause) =>
        noteToolFailureMessage(cause, {
          unknownNotesConsequence: "Nothing was kept.",
          otherwise: noteNotKeptMessage,
        }),
      recordedInput: (input) => ({
        ...input,
        text: textForModel({
          text: keptTextOf(source, input.text),
          trustLevel: source.trustLevel,
        }),
        ...(input.openLoop === undefined
          ? {}
          : {
              openLoop: {
                ...input.openLoop,
                kind: kindForModel(input.openLoop.kind, source.trustLevel),
              },
            }),
      }),
      work: Effect.fnUntraced(function* captureNoteEffect({
        text,
        url,
        linkedNoteIds,
        openLoop,
      }) {
        const dueAt = yield* resolveOpenLoopDue(
          services,
          openLoop?.localDueTime
        );
        const timeZone = yield* services.ownerTimeZone;
        const {
          note,
          alreadyKept,
          linkedNoteIds: linked,
        } = yield* services.notes.capture({
          text: keptTextOf(source, text),
          url,
          source,
          linkedNoteIds,
          openLoop:
            openLoop === undefined ? undefined : { kind: openLoop.kind, dueAt },
        });
        return {
          noteId: note.noteId,
          text: textForModel(note),
          url: note.url ?? null,
          alreadyKept,
          linkedNoteIds: linked,
          openLoop: openLoopForModel(note, timeZone),
        };
      }),
    }
  );
