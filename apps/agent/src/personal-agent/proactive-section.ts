import type { Note } from "../notes/notes.ts";
import { openLoopForModel, textForModel } from "../notes/recalled-note.ts";
import type { OwnerTimeZone } from "../notes/recalled-note.ts";
import { proactiveMarker } from "./proactive-marker.ts";
import type { ProactiveOutcome } from "./storage-values.ts";

const recentOutcomesText = (outcomes: readonly ProactiveOutcome[]) =>
  outcomes.length === 0
    ? ""
    : ` [recent Outcomes of earlier Proactive Messages about it, newest first: ${outcomes.join(", ")}]`;

const openLoopLine = (
  note: Note,
  timeZone: OwnerTimeZone,
  outcomes: readonly ProactiveOutcome[]
) => {
  const openLoop = openLoopForModel(note, timeZone);
  const due = openLoop?.localDueTime ?? "none";
  return `- ${note.noteId} (${openLoop?.kind ?? "open"}, due: ${due}): ${textForModel(note)}${recentOutcomesText(outcomes)}`;
};

export const proactiveSection = (
  openLoops: readonly Note[],
  timeZone: OwnerTimeZone,
  recentOutcomes: ReadonlyMap<string, readonly ProactiveOutcome[]>
) =>
  [
    `${proactiveMarker} The Owner is not present. You start this message yourself. The Owner did not ask for it. It comes from a Schedule that you set. It is due now.`,
    "The stored prompt is your only input. Do the work with your read tools. You can search and read Notes, list Open Loops, and list Schedules. You can close an Open Loop only when your Notes already show that it is done or dropped. Do not close one to tidy up. You can set your own next follow-up with set_schedule, a RunPrompt Schedule with openLoopIds. When the Owner keeps ignoring an Open Loop, change the approach (another time, a smaller step) or ask why in your message. You cannot change anything else.",
    "Your answer goes to the Owner as one message. Write it as a message to the Owner, and make it short. Do not ask a question that needs a reply to finish the work.",
    openLoops.length === 0
      ? "The Open Loops in reach: none are open."
      : [
          "The Open Loops in reach (the earliest due first). This message is about them. Each line shows the Note id, the kind, the local due time, and the text:",
          ...openLoops.map((note) =>
            openLoopLine(note, timeZone, recentOutcomes.get(note.noteId) ?? [])
          ),
          "An Outcome says what the Owner did with an earlier Proactive Message: acted (an Open Loop of it changed), replied (the Owner answered and changed no Open Loop), muted (the Owner asked for less of it), or ignored (no answer in the response window). When the Owner keeps ignoring an Open Loop, change your approach (another time, a smaller step) or ask why. Do not repeat the same message.",
        ].join("\n"),
  ].join("\n");
