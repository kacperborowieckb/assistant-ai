import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import {
  noteSourceOfBurst,
  trustLevelOfBurst,
  turnEventOf,
} from "../personal-agent/burst.ts";
import type { Burst, BurstNoteSource } from "../personal-agent/burst.ts";
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

export const messageNotNamedMessage =
  "These Owner messages hold a forwarded message together with other messages, so the Note must name the message it keeps. Nothing was kept. Call capture_note again with message set to the number in the [Message n of m] label of the message to keep.";

export const messageOutsideBurstMessage = (message: number, count: number) =>
  `There is no Owner message ${message} in this Turn: its Owner messages are numbered 1 to ${count}. Nothing was kept. Call capture_note again with message set to the number in the [Message n of m] label of the message to keep.`;

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
  message: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.annotate({
        description:
          "The number in the [Message n of m] label of the Owner message to keep, when the Owner messages are numbered. The Note keeps that message as its source, and for a forwarded message its forwarded text.",
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

const sourceOrRefusal = (
  chosen: BurstNoteSource,
  message: number | undefined
) =>
  chosen._tag === "Named"
    ? Effect.succeed(chosen.source)
    : Effect.fail(
        new ToolFailed({
          message:
            chosen._tag === "NotNamed"
              ? messageNotNamedMessage
              : messageOutsideBurstMessage(message ?? 0, chosen.count),
        })
      );

export const captureNoteTool = (
  { notes, ownerTimeZone, progress, redactor }: NoteToolServices,
  burst: Burst
) =>
  recordedTool(
    { eventId: turnEventOf(burst).eventId, progress, redactor },
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
      recordedInput: (input) => {
        const chosen = noteSourceOfBurst(burst, input.message);
        const trustLevel = trustLevelOfBurst(burst);
        return {
          ...input,
          text: textForModel({
            text:
              chosen._tag === "Named"
                ? keptTextOf(chosen.source, input.text)
                : input.text,
            trustLevel,
          }),
          ...(input.openLoop === undefined
            ? {}
            : {
                openLoop: {
                  ...input.openLoop,
                  kind: textForModel({
                    text: input.openLoop.kind,
                    trustLevel,
                  }),
                },
              }),
        };
      },
      work: Effect.fnUntraced(function* captureNoteEffect({
        text,
        url,
        message,
        linkedNoteIds,
        openLoop,
      }) {
        const source = yield* sourceOrRefusal(
          noteSourceOfBurst(burst, message),
          message
        );
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
