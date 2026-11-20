import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Journal } from "../journal/journal.ts";
import type { NoteToolServices } from "../notes/note-tool-services.ts";
import { noteToolsFor } from "../notes/note-tools.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import {
  proactiveMessageBudgetTool,
  proactiveMessageBudgetToolName,
} from "../preferences/proactive-message-budget-tool.ts";
import {
  quietHoursTool,
  quietHoursToolName,
} from "../preferences/quiet-hours-tool.ts";
import {
  setTimeZoneTool,
  setTimeZoneToolName,
} from "../preferences/set-time-zone-tool.ts";
import {
  muteProactiveMessageTool,
  muteProactiveMessageToolName,
} from "../proactive/mute-proactive-message-tool.ts";
import { mutedAmong } from "../proactive/muted-open-loops.ts";
import type { ProactiveMessages } from "../proactive/proactive-messages.ts";
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
import type { ScheduleToolServices } from "../schedule/schedule-tool-services.ts";
import type { Schedules } from "../schedule/schedules.ts";
import {
  setScheduleTool,
  setScheduleToolName,
} from "../schedule/set-schedule-tool.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { trustLevelOfEvent } from "./event-trust.ts";
import type { OwnerMessageEvent } from "./inbox.ts";
import { staySilentTool, staySilentToolName } from "./stay-silent-tool.ts";

export interface OwnerMessageToolServices extends Omit<
  NoteToolServices,
  "ownerTimeZone"
> {
  readonly journal: Journal["Service"];
  readonly profile: Profile["Service"];
  readonly preferences: OwnerPreferences["Service"];
  readonly proactiveMessages: ProactiveMessages["Service"];
  readonly schedules: Schedules["Service"];
  readonly behavior: BehaviorConfig;
}

export const scheduleToolServicesOf = (
  {
    schedules,
    preferences,
    notes,
    behavior,
    progress,
    redactor,
  }: Pick<
    OwnerMessageToolServices,
    "behavior" | "notes" | "preferences" | "progress" | "redactor" | "schedules"
  >,
  turnOrigin: ScheduleToolServices["turnOrigin"]
): ScheduleToolServices => ({
  schedules,
  ownerTimeZone: ownerTimeZone(behavior).pipe(
    Effect.provideService(OwnerPreferences, preferences),
    Effect.orDie
  ),
  mutedAmong: (noteIds) => mutedAmong({ preferences, notes }, noteIds),
  progress,
  redactor,
  maxActiveScheduledTasks: behavior.maxActiveScheduledTasks,
  maxActiveAgentSchedules: behavior.maxActiveAgentSchedules,
  turnOrigin,
});

export const ownerMessageTools = (
  event: OwnerMessageEvent,
  {
    journal,
    profile,
    preferences,
    proactiveMessages,
    schedules,
    behavior,
    ...noteServices
  }: OwnerMessageToolServices
) => {
  const { progress, redactor } = noteServices;
  const scheduleServices = scheduleToolServicesOf(
    {
      schedules,
      preferences,
      notes: noteServices.notes,
      behavior,
      progress,
      redactor,
    },
    "owner-message"
  );
  return {
    ...noteToolsFor(
      { ...noteServices, ownerTimeZone: scheduleServices.ownerTimeZone },
      event
    ),
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
            {
              preferences,
              schedules,
              journal,
              progress,
              redactor,
              defaultQuietHours: behavior.quietHours,
            },
            event.eventId
          ),
          [quietHoursToolName]: quietHoursTool(
            {
              preferences,
              schedules,
              journal,
              progress,
              redactor,
              defaultQuietHours: behavior.quietHours,
            },
            event.eventId
          ),
          [proactiveMessageBudgetToolName]: proactiveMessageBudgetTool(
            {
              preferences,
              progress,
              redactor,
              defaultSends: behavior.proactiveMessageBudget,
            },
            event.eventId
          ),
          [muteProactiveMessageToolName]: muteProactiveMessageTool(
            {
              preferences,
              notes: noteServices.notes,
              proactiveMessages,
              progress,
              redactor,
            },
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
          [staySilentToolName]: staySilentTool,
        }
      : {}),
  };
};
