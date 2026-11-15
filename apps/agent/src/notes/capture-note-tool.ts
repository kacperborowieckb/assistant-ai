import { Effect, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import type { InboxEvent } from "../personal-agent/inbox.ts";
import { noteSourceOfOwnerEvent } from "./note.ts";
import type { NoteSource } from "./note.ts";
import type { Notes } from "./notes.ts";

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
});

const captureNoteTool = (notes: Notes["Service"], source: NoteSource) =>
  agentTool({
    description:
      "Keep a Note for the Owner: a text, a link, or a text with a link. Does not open the link.",
    inputSchema: effectInputSchema(CaptureNoteInput),
    execute: ({ text, url }) =>
      notes.capture({ text, url, source }).pipe(
        Effect.map(({ note, alreadyKept }) => ({
          noteId: note.noteId,
          text: note.text,
          url: note.url ?? null,
          alreadyKept,
        })),
        Effect.catchCause(() =>
          Effect.fail(new ToolFailed({ message: noteNotKeptMessage }))
        )
      ),
  });

export const noteToolsFor = (notes: Notes["Service"], event: InboxEvent) => ({
  [captureNoteToolName]: captureNoteTool(notes, noteSourceOfOwnerEvent(event)),
});
