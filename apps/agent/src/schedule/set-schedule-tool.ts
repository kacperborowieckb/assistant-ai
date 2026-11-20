import { DateTime, Effect, Option, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { noteToolFailureMessage } from "../notes/note-tool-failure-message.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import {
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
import { RecurrenceRuleSchema } from "../time/recurrence-rule.ts";
import { refuseAtAgentScheduleLimit } from "./active-agent-schedule-limit-reached.ts";
import { refuseAtScheduledTaskLimit } from "./active-scheduled-task-limit-reached.ts";
import { refuseNotOpenLoops } from "./not-open-loops.ts";
import { ScheduleActionInputSchema } from "./schedule-action-input.ts";
import { resolveScheduleDue } from "./schedule-due.ts";
import { scheduleOf } from "./schedule-presentation.ts";
import type { ScheduleToolServices } from "./schedule-tool-services.ts";

export const maxOpenLoopIdsPerSchedule = 20;

export const setScheduleToolName = "set_schedule";

export const scheduleNotSetMessage =
  "The Schedule was not set. Tell the Owner that you could not set it.";

export const noTimeZoneForScheduleMessage = `The time zone of the Owner is not known, so no Schedule was set. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then set the Schedule.`;

export const invalidLocalDueTimeMessage = `The due time is not a real local date and time in the form ${localDueTimeFormat}. No Schedule was set. Check the date and call ${setScheduleToolName} again.`;

export const dueTimeInThePastMessage =
  "The due time is in the past, so no Schedule was set. Tell the Owner that the time has passed and ask for a time in the future.";

export const noDueGivenMessage = `Neither a local due time nor a repeat rule was given, so no Schedule was set. Ask the Owner when the Schedule is due, and call ${setScheduleToolName} again.`;

export const dueAndRepeatGivenMessage = `Both a local due time and a repeat rule were given, so no Schedule was set. Give only one of them and call ${setScheduleToolName} again.`;

export const mutedOpenLoopsMessage = (noteIds: readonly string[]) =>
  `The Owner asked for less of these Open Loops: ${noteIds.join(", ")}. No Schedule was set. They appear only in the Brief. Set no follow-up for them.`;

export const followUpNeedsOpenLoopsMessage = `A follow-up needs at least one Open Loop and the RunPrompt Action, so no Schedule was set. Pass the ids of the Open Loops in openLoopIds, with a RunPrompt action, and call ${setScheduleToolName} again.`;

const SetScheduleInput = Schema.Struct({
  action: ScheduleActionInputSchema,
  localDueTime: Schema.optionalKey(
    LocalDueTimeSchema.pipe(
      Schema.annotate({
        description: `For a one-time Schedule: the local date and time of the Owner when it is due, as ${localDueTimeFormat} with no time zone or offset, for example 2026-11-19T09:00. Work it out from the current local time that you were given. Leave it out when you give repeat.`,
      })
    )
  ),
  repeat: Schema.optionalKey(
    RecurrenceRuleSchema.pipe(
      Schema.annotate({
        description:
          'For a repeating Schedule: the rule, for example {"_tag":"Weekly","weekdays":["Monday"],"time":"09:00"}, {"_tag":"Daily","time":"08:00"}, or {"_tag":"Monthly","day":"last","time":"18:00"}. The time is the local time of the Owner and stays the same when daylight saving time changes. Leave out localDueTime when you give repeat.',
      })
    )
  ),
  noteId: Schema.optionalKey(
    Schema.String.pipe(
      Schema.annotate({
        description:
          "The id of the Note that this Schedule is about, when the Owner asked for the Schedule together with something to keep. Use an id that capture_note or search_notes returned.",
      })
    )
  ),
  openLoopIds: Schema.optionalKey(
    Schema.Array(Schema.String).pipe(
      Schema.check(Schema.isMaxLength(maxOpenLoopIdsPerSchedule)),
      Schema.annotate({
        description:
          "The ids of the Open Loops (Notes with an Open Loop) that this Schedule is about. Give them for a follow-up that you set yourself: a RunPrompt Schedule before the due date of an Open Loop, or one check on an Open Loop that had no change for about a day. Use ids that list_open_loops, search_notes, or capture_note returned. Leave them out for a Schedule that the Owner asked for.",
      })
    )
  ),
  ownerAskedForSchedule: Schema.optionalKey(
    Schema.Boolean.pipe(
      Schema.annotate({
        description:
          "Set true only when the Owner asked in this message for this Schedule. Leave it out for a follow-up that you set yourself with openLoopIds.",
      })
    )
  ),
});

export const setScheduleTool = (
  {
    schedules,
    ownerTimeZone,
    mutedAmong,
    progress,
    redactor,
    maxActiveScheduledTasks,
    maxActiveAgentSchedules,
    turnOrigin,
  }: ScheduleToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: setScheduleToolName,
      description:
        "Set a Schedule for the Owner, one-time with localDueTime or repeating with repeat. The action says what happens at the due time. With SendText, the saved text is sent to the Owner in the chat; use it for fixed words for the Owner, such as a Reminder. With RunPrompt, the agent runs the saved prompt at the due time and sends the result. This is a Scheduled Task. A follow-up is a RunPrompt Schedule that you set yourself with openLoopIds, when the Owner did not ask for a Schedule (leave out ownerAskedForSchedule): set one before the due date of an Open Loop, and one when an Open Loop had no change for about a day. When a follow-up fires, you can set the next one the same way. Use it for work to do at the due time, such as listing open tasks from the Notes of that day. Give times as the local time of the Owner. Fails with a message when the time zone is not known, neither or both of localDueTime and repeat are given, the time is in the past, or the time is not real. Say that the Schedule is set only after it succeeded, and give the local date, weekday, and time of the first due time that it returns, and for a repeating Schedule how it repeats.",
      inputSchema: SetScheduleInput,
      failureMessage: (cause) =>
        noteToolFailureMessage(cause, {
          unknownNotesConsequence: "No Schedule was set.",
          otherwise: scheduleNotSetMessage,
        }),
      work: Effect.fnUntraced(function* storeScheduleEffect({
        action,
        localDueTime,
        repeat,
        noteId,
        openLoopIds,
        ownerAskedForSchedule,
      }) {
        const hasOpenLoops =
          openLoopIds !== undefined && openLoopIds.length > 0;
        const isFollowUp =
          turnOrigin === "proactive" ||
          (hasOpenLoops && ownerAskedForSchedule !== true);
        if (isFollowUp && (!hasOpenLoops || action._tag !== "RunPrompt")) {
          return yield* new ToolFailed({
            message: followUpNeedsOpenLoopsMessage,
          });
        }
        if (isFollowUp) {
          const muted = yield* mutedAmong(openLoopIds ?? []);
          if (muted.length > 0) {
            return yield* new ToolFailed({
              message: mutedOpenLoopsMessage(muted),
            });
          }
        }
        const timeZone = yield* ownerTimeZone;
        if (Option.isNone(timeZone)) {
          return yield* new ToolFailed({
            message: noTimeZoneForScheduleMessage,
          });
        }
        const due = yield* resolveScheduleDue(
          { localDueTime, repeat },
          timeZone.value,
          {
            bothGiven: dueAndRepeatGivenMessage,
            invalidLocalDueTime: invalidLocalDueTimeMessage,
            localDueTimeInThePast: dueTimeInThePastMessage,
          }
        );
        if (Option.isNone(due)) {
          return yield* new ToolFailed({ message: noDueGivenMessage });
        }
        const { schedule: stored, alreadySet } = yield* schedules
          .set({
            action,
            setBy: isFollowUp ? "agent" : "owner",
            noteId,
            openLoopIds,
            dueAt: due.value.dueAt,
            repeat: due.value.repeat,
            sourceEventId: eventId,
            activeScheduledTaskLimit: maxActiveScheduledTasks,
            activeAgentScheduleLimit: maxActiveAgentSchedules,
          })
          .pipe(
            refuseAtScheduledTaskLimit,
            refuseAtAgentScheduleLimit,
            refuseNotOpenLoops
          );
        return {
          ...scheduleOf(stored, timeZone.value),
          timeZone: DateTime.zoneToString(timeZone.value),
          alreadySet,
        };
      }),
    }
  );
