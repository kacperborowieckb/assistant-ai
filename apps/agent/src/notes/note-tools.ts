import type { InboxEvent } from "../personal-agent/inbox.ts";
import { captureNoteTool, captureNoteToolName } from "./capture-note-tool.ts";
import {
  listLinkedNotesTool,
  listLinkedNotesToolName,
} from "./list-linked-notes-tool.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { noteSourceOfEvent } from "./note.ts";
import { searchNotesTool, searchNotesToolName } from "./search-notes-tool.ts";
import { updateNoteTool, updateNoteToolName } from "./update-note-tool.ts";

export const noteToolsFor = (
  services: NoteToolServices,
  event: InboxEvent
) => ({
  [captureNoteToolName]: captureNoteTool(services, noteSourceOfEvent(event)),
  [updateNoteToolName]: updateNoteTool(services, event.eventId),
  [searchNotesToolName]: searchNotesTool(services, event.eventId),
  [listLinkedNotesToolName]: listLinkedNotesTool(services, event.eventId),
});
