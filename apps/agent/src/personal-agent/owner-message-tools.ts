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
import type { ScheduleAlarm } from "../schedule/schedule-alarm.ts";
import type { Schedules } from "../schedule/schedules.ts";
import {
  setReminderTool,
  setReminderToolName,
} from "../schedule/set-reminder-tool.ts";
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
            { preferences, progress, redactor },
            event.eventId
          ),
          [setReminderToolName]: setReminderTool(
            {
              schedules,
              alarm,
              ownerTimeZone: ownerTimeZone(behavior).pipe(
                Effect.provideService(OwnerPreferences, preferences),
                Effect.orDie
              ),
              progress,
              redactor,
            },
            event.eventId
          ),
        }
      : {}),
  };
};
