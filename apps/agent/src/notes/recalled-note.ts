import { Option } from "effect";

import { markUntrustedContent } from "./note.ts";
import type { Note } from "./notes.ts";
import { openLoopForModel } from "./open-loop-presentation.ts";

export const textForModel = (note: Pick<Note, "text" | "trustLevel">) =>
  note.trustLevel === "untrusted" ? markUntrustedContent(note.text) : note.text;

export const recalledNote = (note: Note) => ({
  noteId: note.noteId,
  text: textForModel(note),
  url: note.url ?? null,
  source: {
    channel: note.source.channel,
    conversationId: note.source.conversationId,
    channelMessageId: note.source.channelMessageId,
    forwardOrigin:
      note.source.forwardOrigin === undefined
        ? null
        : markUntrustedContent(note.source.forwardOrigin),
  },
  trustLevel: note.trustLevel,
  capturedAt: note.capturedAt,
  openLoop: openLoopForModel(note.openLoop, Option.none()),
});
