import { Cause, Effect, Option, Schema } from "effect";

import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { NoOpenLoop } from "./no-open-loop.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { OpenLoopClosedReasonSchema } from "./open-loop.ts";
import { openLoopForModel, textForModel } from "./recalled-note.ts";

export const closeOpenLoopToolName = "close_open_loop";

export const openLoopNotClosedMessage =
  "The Open Loop was not closed. Tell the Owner that you could not close it.";

export const noOpenLoopMessage = (noteId: string) =>
  `The Note ${noteId} has no open Open Loop, so nothing was closed. Use a Note id whose Open Loop is open, from list_open_loops or search_notes.`;

const CloseOpenLoopInput = Schema.Struct({
  noteId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The id of the Note whose Open Loop to close. Use an id that list_open_loops, search_notes, or capture_note returned.",
    })
  ),
  reason: OpenLoopClosedReasonSchema.pipe(
    Schema.annotate({
      description:
        "Why it is closed: done when the Owner did it, dropped when the Owner will not do it, replaced when another Note takes its place.",
    })
  ),
});

const closeFailureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && error.value instanceof NoOpenLoop
    ? noOpenLoopMessage(error.value.noteId)
    : noteToolFailureMessage(cause, {
        unknownNotesConsequence: "Nothing was closed.",
        otherwise: openLoopNotClosedMessage,
      });
};

export const closeOpenLoopTool = (
  { notes, ownerTimeZone, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: closeOpenLoopToolName,
      description:
        "Close the open Open Loop of one Note when the Owner says that it is done, dropped, or replaced. The Note stays. Fails with a message when no Note has the id or the Note has no open Open Loop. Say that it is closed only after it succeeded.",
      inputSchema: CloseOpenLoopInput,
      failureMessage: closeFailureMessage,
      work: Effect.fnUntraced(function* closeOpenLoopEffect({
        noteId,
        reason,
      }) {
        const { note, alreadyClosed } = yield* notes.closeOpenLoop({
          noteId,
          eventId,
          reason,
        });
        return {
          noteId: note.noteId,
          text: textForModel(note),
          openLoop: openLoopForModel(note.openLoop, yield* ownerTimeZone),
          alreadyClosed,
        };
      }),
    }
  );
