import { Effect, Schema } from "effect";

import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { openLoopForModel } from "./open-loop-presentation.ts";
import type { OpenLoopToolServices } from "./open-loop-tool-services.ts";
import { maxOpenLoopsPerPage } from "./open-loop.ts";
import { sourceForModel, textForModel } from "./recalled-note.ts";

export const listOpenLoopsToolName = "list_open_loops";

export const openLoopsNotListedMessage =
  "The open Open Loops could not be listed. Tell the Owner that you could not look in your Notes.";

const ListOpenLoopsInput = Schema.Struct({
  offset: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.annotate({
        description: `How many Open Loops to skip. The default is 0. Use the number of Open Loops that you already have to get the next page of ${maxOpenLoopsPerPage}.`,
      })
    )
  ),
});

export const listOpenLoopsTool = (
  services: OpenLoopToolServices,
  eventId: string
) =>
  recordedTool(
    {
      eventId,
      progress: services.progress,
      redactor: services.redactor,
    },
    {
      name: listOpenLoopsToolName,
      description: `List the open Open Loops of the Owner: the Notes that are things to do or to come back to. Due ones come first, the earliest due first, then the ones without a due time, oldest first. Returns ${maxOpenLoopsPerPage} at a time with the total count. Use it when the Owner asks what is open. When openLoopCount is 0, nothing is open. An empty openLoops list with a count above 0 only means that no Open Loops remain at that offset.`,
      inputSchema: ListOpenLoopsInput,
      failureMessage: openLoopsNotListedMessage,
      work: Effect.fnUntraced(function* listOpenLoopsEffect({ offset }) {
        const timeZone = yield* services.ownerTimeZone;
        const { notes, openLoopCount } = yield* services.notes.listOpenLoops(
          offset ?? 0
        );
        return {
          openLoops: notes.map((note) => ({
            noteId: note.noteId,
            text: textForModel(note),
            url: note.url ?? null,
            source: sourceForModel(note),
            trustLevel: note.trustLevel,
            capturedAt: note.capturedAt,
            openLoop: openLoopForModel(note.openLoop, timeZone),
          })),
          openLoopCount,
        };
      }),
    }
  );
