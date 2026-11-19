import { Effect, Schema, Option } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { NoOpenLoop } from "./no-open-loop.ts";
import { noteToolFailureMessage } from "./note-tool-failure-message.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { openLoopForModel } from "./open-loop-presentation.ts";
import { OpenLoopCloseReasonSchema } from "./open-loop.ts";

export const closeOpenLoopToolName = "close_open_loop";

export const openLoopNotClosedMessage =
  "The Open Loop was not closed. Tell the Owner that you could not close it.";

export const noOpenLoopMessage = (noteId: string) =>
  `The Note ${noteId} has no open Open Loop, so nothing was changed. Tell the Owner this. Call list_open_loops when you need the Notes with an open Open Loop.`;

const CloseOpenLoopInput = Schema.Struct({
  noteId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The id of the Note whose Open Loop to close. Use an id that list_open_loops or search_notes returned.",
    })
  ),
  reason: OpenLoopCloseReasonSchema.pipe(
    Schema.annotate({
      description:
        "Why it is closed: done when the Owner did it, dropped when the Owner no longer wants it, replaced when another Note or Open Loop takes its place.",
    })
  ),
});

export const closeOpenLoopTool = (
  { notes, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: closeOpenLoopToolName,
      description:
        "Close the open Open Loop of one Note when the Owner says that it is done or dropped. Fails when the Note is unknown or has no open Open Loop, and then changes nothing.",
      inputSchema: CloseOpenLoopInput,
      failureMessage: (cause) =>
        noteToolFailureMessage(cause, {
          unknownNotesConsequence: "Nothing was closed.",
          otherwise: openLoopNotClosedMessage,
        }),
      work: ({ noteId, reason }) =>
        notes.closeOpenLoop({ noteId, eventId, reason }).pipe(
          Effect.catchTag("NoOpenLoop", (failure: NoOpenLoop) =>
            Effect.fail(
              new ToolFailed({ message: noOpenLoopMessage(failure.noteId) })
            )
          ),
          Effect.map(({ note }) => ({
            noteId: note.noteId,
            openLoop: openLoopForModel(note.openLoop, Option.none()),
          }))
        ),
    }
  );
