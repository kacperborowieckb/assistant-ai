import type { Note } from "../notes/notes.ts";
import { openLoopForModel, textForModel } from "../notes/recalled-note.ts";
import type { OwnerTimeZone } from "../notes/recalled-note.ts";
import { proactiveMarker } from "./proactive-marker.ts";

const openLoopLine = (note: Note, timeZone: OwnerTimeZone) => {
  const openLoop = openLoopForModel(note, timeZone);
  const due = openLoop?.localDueTime ?? "none";
  return `- ${note.noteId} (${openLoop?.kind ?? "open"}, due: ${due}): ${textForModel(note)}`;
};

export const proactiveSection = (
  openLoops: readonly Note[],
  timeZone: OwnerTimeZone
) =>
  [
    `${proactiveMarker} The Owner is not present. You start this message yourself. The Owner did not ask for it. It comes from a Schedule that you set. It is due now.`,
    "The stored prompt is your only input. Do the work with your read tools only. You can search and read Notes, list Open Loops, and list Schedules. You cannot change anything.",
    "Your answer goes to the Owner as one message. Write it as a message to the Owner, and make it short. Do not ask a question that needs a reply to finish the work.",
    openLoops.length === 0
      ? "The Open Loops in reach: none are open."
      : [
          "The Open Loops in reach (the earliest due first). This message is about them. Each line shows the Note id, the kind, the local due time, and the text:",
          ...openLoops.map((note) => openLoopLine(note, timeZone)),
        ].join("\n"),
  ].join("\n");
