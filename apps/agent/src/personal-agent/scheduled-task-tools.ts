import {
  listLinkedNotesTool,
  listLinkedNotesToolName,
} from "../notes/list-linked-notes-tool.ts";
import {
  searchNotesTool,
  searchNotesToolName,
} from "../notes/search-notes-tool.ts";
import {
  listSchedulesTool,
  listSchedulesToolName,
} from "../schedule/list-schedules-tool.ts";
import { scheduleToolServicesOf } from "./owner-message-tools.ts";
import type { OwnerMessageToolServices } from "./owner-message-tools.ts";

export type ScheduledTaskToolServices = Omit<
  OwnerMessageToolServices,
  "profile"
>;

export const scheduledTaskTools = (
  eventId: string,
  services: ScheduledTaskToolServices
) => {
  const { notes, progress, redactor } = services;
  const noteServices = { notes, progress, redactor };
  return {
    [searchNotesToolName]: searchNotesTool(noteServices, eventId),
    [listLinkedNotesToolName]: listLinkedNotesTool(noteServices, eventId),
    [listSchedulesToolName]: listSchedulesTool(
      scheduleToolServicesOf(services),
      eventId
    ),
  };
};
