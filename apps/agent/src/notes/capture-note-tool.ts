import { Effect } from "effect";
import { z } from "zod";

import { agentTool, ToolFailed } from "../model-gateway/agent-tool.ts";
import type { InboxEvent } from "../personal-agent/inbox.ts";
import { noteSourceOfOwnerEvent } from "./note.ts";
import type { NoteSource } from "./note.ts";
import type { Notes } from "./notes.ts";

export const captureNoteToolName = "capture_note";

export const noteNotKeptMessage =
  "The Note was not kept. Tell the Owner that you could not keep it.";

const CaptureNoteInput = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .describe("What to keep, in the Owner's words. For a link, the comment."),
  url: z
    .string()
    .regex(/^https?:\/\/\S+$/u)
    .optional()
    .describe("The link to keep, when the Owner sent one."),
});

const captureNoteTool = (notes: Notes["Service"], source: NoteSource) =>
  agentTool({
    description:
      "Keep a Note for the Owner: a text, a link, or a text with a link. Does not open the link.",
    inputSchema: CaptureNoteInput,
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
