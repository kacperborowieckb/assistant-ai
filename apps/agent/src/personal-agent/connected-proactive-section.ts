import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Note } from "../notes/notes.ts";
import { openLoopForModel, textForModel } from "../notes/recalled-note.ts";
import type { OwnerTimeZone } from "../notes/recalled-note.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import { deliveryStateOf } from "./delivery.ts";
import type { OwnerMessageEvent } from "./inbox.ts";
import type { TurnPreparation } from "./model-turn.ts";

const openLoopLine = (note: Note, timeZone: OwnerTimeZone) => {
  const openLoop = openLoopForModel(note, timeZone);
  return `- ${note.noteId} (${openLoop?.kind ?? "none"}, ${openLoop?.state ?? "no Open Loop"}, due: ${openLoop?.localDueTime ?? "none"}): ${textForModel(note)}`;
};

export const connectedProactivePreparation = Effect.fnUntraced(
  function* connectedProactivePreparation(
    behavior: BehaviorConfig,
    event: OwnerMessageEvent
  ) {
    const proactiveMessages = yield* ProactiveMessages;
    const { notes } = yield* agentToolServices;
    const connected = yield* proactiveMessages.connectedTo(event.eventId);
    if (connected === undefined) {
      return {
        situation: [],
        lateText: (text) => text,
      } satisfies TurnPreparation;
    }
    const delivery = yield* deliveryStateOf(connected.eventId);
    const sentText = delivery._tag === "Sent" ? delivery.text : undefined;
    const timeZone = yield* ownerTimeZone(behavior);
    const openLoops = yield* notes.byIds(connected.openLoopIds);
    return {
      situation: [
        [
          "This message of the Owner follows a Proactive Message that you sent. The Owner may be answering it. Code connected the two, because this is the next message of the Owner after it, within the response window. The Owner used no reply-to. Treat the message as an answer when it fits. Otherwise treat it as a normal message.",
          sentText === undefined
            ? "The text of the Proactive Message is not known."
            : `The Proactive Message said: ${sentText}`,
          openLoops.length === 0
            ? "The Proactive Message was about no Open Loops."
            : [
                "The Open Loops of the Proactive Message. Each line shows the Note id, the kind, the state, the local due time, and the text:",
                ...openLoops.map((note) => openLoopLine(note, timeZone)),
              ].join("\n"),
        ].join("\n"),
      ],
      lateText: (text) => text,
    } satisfies TurnPreparation;
  }
);
