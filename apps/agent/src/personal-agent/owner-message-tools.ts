import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { NoteToolServices } from "../notes/note-tool-services.ts";
import { noteToolsFor } from "../notes/note-tools.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import {
  setTimeZoneTool,
  setTimeZoneToolName,
} from "../preferences/set-time-zone-tool.ts";
import type { Profile } from "../profile/profile.ts";
import {
  updateProfileTool,
  updateProfileToolName,
} from "../profile/update-profile-tool.ts";
import {
  cancelScheduleTool,
  cancelScheduleToolName,
} from "../schedule/cancel-schedule-tool.ts";
import {
  changeScheduleTool,
  changeScheduleToolName,
} from "../schedule/change-schedule-tool.ts";
import {
  listSchedulesTool,
  listSchedulesToolName,
} from "../schedule/list-schedules-tool.ts";
import type { ScheduleAlarm } from "../schedule/schedule-alarm.ts";
import type { ScheduleToolServices } from "../schedule/schedule-tool-services.ts";
import type { Schedules } from "../schedule/schedules.ts";
import {
  setScheduleTool,
  setScheduleToolName,
} from "../schedule/set-schedule-tool.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { trustLevelOfEvent } from "./event-trust.ts";
import type { OwnerMessageEvent } from "./inbox.ts";

export interface OwnerMessageToolServices extends NoteToolServices {
  readonly profile: Profile["Service"];
  readonly preferences: OwnerPreferences["Service"];
  readonly schedules: Schedules["Service"];
  readonly alarm: ScheduleAlarm["Service"];
  readonly behavior: BehaviorConfig;
}

export const scheduleToolServicesOf = ({
  schedules,
  alarm,
  preferences,
  behavior,
  progress,
  redactor,
}: Pick<
  OwnerMessageToolServices,
  "alarm" | "behavior" | "preferences" | "progress" | "redactor" | "schedules"
>): ScheduleToolServices => ({
  schedules,
  alarm,
  ownerTimeZone: ownerTimeZone(behavior).pipe(
    Effect.provideService(OwnerPreferences, preferences),
    Effect.orDie
  ),
  progress,
  redactor,
  maxActiveScheduledTasks: behavior.maxActiveScheduledTasks,
});

export const ownerMessageTools = (
  event: OwnerMessageEvent,
  {
    profile,
    preferences,
    schedules,
    alarm,
    behavior,
    ...noteServices
  }: OwnerMessageToolServices
) => {
  const { progress, redactor } = noteServices;
  const scheduleServices = scheduleToolServicesOf({
    schedules,
    alarm,
    preferences,
    behavior,
    progress,
    redactor,
  });
  return {
    ...noteToolsFor(noteServices, event),
    ...(trustLevelOfEvent(event) === "owner"
      ? {
          [updateProfileToolName]: updateProfileTool(
            {
              profile,
              progress,
              redactor,
              characterLimit: behavior.maxProfileCharacters,
            },
            event.eventId
          ),
          [setTimeZoneToolName]: setTimeZoneTool(
            { preferences, schedules, alarm, progress, redactor },
            event.eventId
          ),
          [setScheduleToolName]: setScheduleTool(
            scheduleServices,
            event.eventId
          ),
          [listSchedulesToolName]: listSchedulesTool(
            scheduleServices,
            event.eventId
          ),
          [changeScheduleToolName]: changeScheduleTool(
            scheduleServices,
            event.eventId
          ),
          [cancelScheduleToolName]: cancelScheduleTool(
            scheduleServices,
            event.eventId
          ),
        }
      : {}),
  };
};
