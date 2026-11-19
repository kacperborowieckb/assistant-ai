import { uniqueNoteIds } from "./note-links.ts";
import type { UpdateRequest } from "./note-updates.ts";

export const changeOfUpdate = (request: UpdateRequest) => {
  const textChanged = request.text !== undefined;
  const linksChanged =
    uniqueNoteIds(request.linkedNoteIds).length +
      uniqueNoteIds(request.unlinkedNoteIds).length >
    0;
  if (!textChanged && !linksChanged) {
    return;
  }
  if (textChanged && linksChanged) {
    return "text_and_links" as const;
  }
  return textChanged ? ("text" as const) : ("links" as const);
};
