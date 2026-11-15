import { Cause, Option } from "effect";

import { UnknownNotes } from "./unknown-notes.ts";

export const noteToolFailureMessage = (
  cause: Cause.Cause<unknown>,
  messages: {
    readonly unknownNotesConsequence: string;
    readonly otherwise: string;
  }
) => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && error.value instanceof UnknownNotes
    ? `No Note of the Owner has the id ${error.value.noteIds.join(", ")}. ${messages.unknownNotesConsequence} Use a Note id that search_notes or capture_note returned.`
    : messages.otherwise;
};
