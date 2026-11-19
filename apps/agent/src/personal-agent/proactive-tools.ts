import {
  listLinkedNotesTool,
  listLinkedNotesToolName,
} from "../notes/list-linked-notes-tool.ts";
import {
  listOpenLoopsTool,
  listOpenLoopsToolName,
} from "../notes/list-open-loops-tool.ts";
import {
  searchNotesTool,
  searchNotesToolName,
} from "../notes/search-notes-tool.ts";
import {
  listSchedulesTool,
  listSchedulesToolName,
} from "../schedule/list-schedules-tool.ts";
import { scheduleToolServicesOf } from "./owner-message-tools.ts";
import type { ScheduledTaskToolServices } from "./scheduled-task-tools.ts";

export const proactiveTools = (
  eventId: string,
  services: ScheduledTaskToolServices
) => {
  const { notes, progress, redactor } = services;
  const scheduleServices = scheduleToolServicesOf(services);
  const noteServices = {
    notes,
    ownerTimeZone: scheduleServices.ownerTimeZone,
    progress,
    redactor,
  };
  return {
    [searchNotesToolName]: searchNotesTool(noteServices, eventId),
    [listLinkedNotesToolName]: listLinkedNotesTool(noteServices, eventId),
    [listOpenLoopsToolName]: listOpenLoopsTool(noteServices, eventId),
    [listSchedulesToolName]: listSchedulesTool(scheduleServices, eventId),
  };
};
