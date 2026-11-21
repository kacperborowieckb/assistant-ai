import { trustLevelOfBurst, turnEventOf } from "../personal-agent/burst.ts";
import type { Burst } from "../personal-agent/burst.ts";
import { captureNoteTool, captureNoteToolName } from "./capture-note-tool.ts";
import {
  closeOpenLoopTool,
  closeOpenLoopToolName,
} from "./close-open-loop-tool.ts";
import {
  listLinkedNotesTool,
  listLinkedNotesToolName,
} from "./list-linked-notes-tool.ts";
import {
  listOpenLoopsTool,
  listOpenLoopsToolName,
} from "./list-open-loops-tool.ts";
import type { NoteToolServices } from "./note-tool-services.ts";
import { searchNotesTool, searchNotesToolName } from "./search-notes-tool.ts";
import { updateNoteTool, updateNoteToolName } from "./update-note-tool.ts";

export const noteToolsFor = (services: NoteToolServices, burst: Burst) => {
  const { eventId } = turnEventOf(burst);
  return {
    [captureNoteToolName]: captureNoteTool(services, burst),
    ...(trustLevelOfBurst(burst) === "owner"
      ? {
          [updateNoteToolName]: updateNoteTool(services, eventId),
          [closeOpenLoopToolName]: closeOpenLoopTool(services, eventId),
        }
      : {}),
    [searchNotesToolName]: searchNotesTool(services, eventId),
    [listLinkedNotesToolName]: listLinkedNotesTool(services, eventId),
    [listOpenLoopsToolName]: listOpenLoopsTool(services, eventId),
  };
};
