import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { captureNoteToolName } from "../notes/capture-note-tool.ts";
import type { Note } from "../notes/notes.ts";

const keptNotesLine = (keptNotes: readonly Note[]) =>
  keptNotes.length === 0
    ? []
    : [
        `You already kept these Notes for the newest message. Do not keep them again: ${keptNotes
          .map((note) => `"${note.text}" (Note id ${note.noteId})`)
          .join(", ")}.`,
      ];

export const systemPrompt = (
  behavior: BehaviorConfig,
  keptNotes: readonly Note[] = []
) =>
  [
    "You are the Owner's Personal Agent. You talk with the Owner in a chat.",
    "Answer the Owner's newest messages. Be honest when you do not know something.",
    `When the Owner sends something to keep, a text or a link, call ${captureNoteToolName} once for it and then say what you kept.`,
    `Say that you kept something only after ${captureNoteToolName} succeeded. When it fails, say that you could not keep it.`,
    "Never open a link. When the Owner asks for a Reminder, keep the Note only and say that Reminders do not work yet.",
    ...keptNotesLine(keptNotes),
    behavior.textingStyle,
  ].join("\n");
