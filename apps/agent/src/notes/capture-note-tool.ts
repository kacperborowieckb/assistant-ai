import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { noteIdListSchema } from "./note-id-list-schema.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import type { NoteSource } from "./note.ts";
import { OpenLoopInputSchema, openLoopRequestOf } from "./open-loop-input.ts";
import { openLoopForModel, textForModel } from "./recalled-note.ts";

export const captureNoteToolName = "capture_note";

export const noteNotKeptMessage =
  "The Note was not kept. Tell the Owner that you could not keep it.";

export const forwardedInBurstMessage =
  "These Owner messages hold a forwarded message together with other messages, so a Note cannot tell which text to keep with which source. Nothing was kept. Tell the Owner, and ask them to send the message to keep on its own.";

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
  openLoop: Schema.optionalKey(OpenLoopInputSchema),
});

const keptTextOf = (source: NoteSource, text: string) =>
  source.forwardedText ?? text;

export const captureNoteTool = (
  { notes, ownerTimeZone, progress, redactor }: NoteToolServices,
  source: NoteSource,
  refusal?: string
) =>
  recordedTool(
    { eventId: source.eventId, progress, redactor },
    {
      name: captureNoteToolName,
      description:
        "Keep a Note for the Owner at once: a task, a text, a link, or a text with a link. Call it without asking the Owner first. Does not open the link. Give openLoop when the Note is something to do or to come back to; give none for a fact. Fails with a message when a due time is given and the time zone of the Owner is not known.",
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
                kind: textForModel({
                  text: input.openLoop.kind,
                  trustLevel: source.trustLevel,
                }),
              },
            }),
      }),
      work: Effect.fnUntraced(function* captureNoteEffect({
        text,
        url,
        linkedNoteIds,
        openLoop,
      }) {
        if (refusal !== undefined) {
          return yield* new ToolFailed({ message: refusal });
        }
        const openLoopRequest = yield* openLoopRequestOf(
          openLoop,
          ownerTimeZone,
          { toolName: captureNoteToolName, consequence: "Nothing was kept." }
        );
        const {
          note,
          alreadyKept,
          linkedNoteIds: linked,
        } = yield* notes.capture({
          text: keptTextOf(source, text),
          url,
          source,
          linkedNoteIds,
          openLoop: openLoopRequest,
        });
        return {
          noteId: note.noteId,
          text: textForModel(note),
          url: note.url ?? null,
          alreadyKept,
          linkedNoteIds: linked,
          openLoop: openLoopForModel(note, yield* ownerTimeZone),
        };
      }),
    }
  );
