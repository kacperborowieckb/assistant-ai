import { Option } from "effect";
import type { DateTime } from "effect";

import { localTimeOf } from "../time/local-time.ts";
import { markUntrustedContent } from "./note.ts";
import type { Note } from "./notes.ts";
import { dueAtOfOpenLoop } from "./open-loop.ts";
import type { OpenLoop } from "./open-loop.ts";

export type OwnerTimeZone = Option.Option<DateTime.TimeZone.Named>;

export const textForModel = (note: Pick<Note, "text" | "trustLevel">) =>
  note.trustLevel === "untrusted" ? markUntrustedContent(note.text) : note.text;

const localDueTimeOf = (openLoop: OpenLoop, timeZone: OwnerTimeZone) =>
  openLoop.dueAt === undefined || Option.isNone(timeZone)
    ? null
    : localTimeOf(openLoop.dueAt, timeZone.value);

export const openLoopForModel = (
  openLoop: OpenLoop | undefined,
  timeZone: OwnerTimeZone
) =>
  openLoop === undefined
    ? null
    : {
        kind: openLoop.kind,
        state: openLoop._tag === "Open" ? "open" : "closed",
        closedReason: openLoop._tag === "Closed" ? openLoop.reason : null,
        dueAt: dueAtOfOpenLoop(openLoop),
        localDueTime: localDueTimeOf(openLoop, timeZone),
      };

export const recalledNote = (note: Note, timeZone: OwnerTimeZone) => ({
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
  openLoop: openLoopForModel(note.openLoop, timeZone),
});
