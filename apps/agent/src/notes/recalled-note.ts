import { Option } from "effect";

import { markUntrustedContent } from "./note.ts";
import type { Note } from "./notes.ts";
import { openLoopForModel } from "./open-loop-presentation.ts";

export const textForModel = (note: Pick<Note, "text" | "trustLevel">) =>
  note.trustLevel === "untrusted" ? markUntrustedContent(note.text) : note.text;

export const sourceForModel = ({ source }: Pick<Note, "source">) => ({
  channel: source.channel,
  conversationId: source.conversationId,
  channelMessageId: source.channelMessageId,
  forwardOrigin:
    source.forwardOrigin === undefined
      ? null
      : markUntrustedContent(source.forwardOrigin),
});

export const recalledNote = (note: Note) => ({
  noteId: note.noteId,
  text: textForModel(note),
  url: note.url ?? null,
  source: sourceForModel(note),
  trustLevel: note.trustLevel,
  capturedAt: note.capturedAt,
  openLoop: openLoopForModel(note, Option.none()),
});
