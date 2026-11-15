import type { InboxEvent } from "../personal-agent/inbox.ts";
import { captureNoteTool, captureNoteToolName } from "./capture-note-tool.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { noteSourceOfOwnerEvent } from "./note.ts";
import { searchNotesTool, searchNotesToolName } from "./search-notes-tool.ts";

export const noteToolsFor = (
  services: NoteToolServices,
  event: InboxEvent
) => ({
  [captureNoteToolName]: captureNoteTool(
    services,
    noteSourceOfOwnerEvent(event)
  ),
  [searchNotesToolName]: searchNotesTool(services, event.eventId),
});
