import { markUntrustedContent } from "./note.ts";
import type { Note } from "./notes.ts";

const textOf = (note: Note) =>
  note.trustLevel === "untrusted" ? markUntrustedContent(note.text) : note.text;

export const recalledNote = (note: Note) => ({
  noteId: note.noteId,
  text: textOf(note),
  url: note.url ?? null,
  source: {
    channel: note.source.channel,
    conversationId: note.source.conversationId,
    channelMessageId: note.source.channelMessageId,
  },
  trustLevel: note.trustLevel,
  capturedAt: note.capturedAt,
});
