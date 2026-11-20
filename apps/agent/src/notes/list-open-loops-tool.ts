import { Effect, Schema } from "effect";

import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import type { OpenLoopPage } from "./open-loop-store.ts";
import { recalledNote } from "./recalled-note.ts";

export const listOpenLoopsToolName = "list_open_loops";

export const openLoopsNotListedMessage =
  "The Open Loops could not be listed. Tell the Owner that you could not look in your Notes.";

export const openLoopsPerPage = 10;

const nextOffsetOf = (offset: number, page: OpenLoopPage) => {
  const next = offset + page.notes.length;
  return page.notes.length > 0 && next < page.openLoopCount ? next : null;
};

const ListOpenLoopsInput = Schema.Struct({
  offset: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.annotate({
        description: `How many Open Loops to skip. The default is 0. Use the number of Open Loops that you already have to get the next page of ${openLoopsPerPage}.`,
      })
    )
  ),
});

export const listOpenLoopsTool = (
  { notes, ownerTimeZone, progress, redactor }: NoteToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: listOpenLoopsToolName,
      description: `List the Notes with an open Open Loop: the earliest due first, then the ones with no due date, oldest first. Returns ${openLoopsPerPage} at a time, with the total count and nextOffset: call it again with that offset for the next page, or stop when it is null. Closed Open Loops are not listed. An empty list means that nothing is open.`,
      inputSchema: ListOpenLoopsInput,
      readsOnly: true,
      failureMessage: openLoopsNotListedMessage,
      work: ({ offset = 0 }) =>
        Effect.all({
          page: notes.listOpenLoops({ offset, limit: openLoopsPerPage }),
          timeZone: ownerTimeZone,
        }).pipe(
          Effect.map(({ page, timeZone }) => ({
            openLoops: page.notes.map((note) => ({
              ...recalledNote(note, timeZone),
              lastCheckedAt: note.lastCheckedAt,
            })),
            openLoopCount: page.openLoopCount,
            nextOffset: nextOffsetOf(offset, page),
          }))
        ),
    }
  );
