import { Cause, DateTime, Effect, Option, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { noteToolFailureMessage } from "../notes/note-tool-failure-message.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import {
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
import { RecurrenceRuleSchema } from "../time/recurrence-rule.ts";
import { ScheduleActionInputSchema } from "./schedule-action-input.ts";
import { resolveScheduleDue } from "./schedule-due.ts";
import { scheduleOf } from "./schedule-presentation.ts";
import type { ScheduleToolServices } from "./schedule-tool-services.ts";

export const setScheduleToolName = "set_schedule";

export const scheduleNotSetMessage =
  "The Schedule was not set. Tell the Owner that you could not set it.";

export const noTimeZoneForScheduleMessage = `The time zone of the Owner is not known, so no Schedule was set. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then set the Schedule.`;

export const invalidLocalDueTimeMessage = `The due time is not a real local date and time in the form ${localDueTimeFormat}. No Schedule was set. Check the date and call ${setScheduleToolName} again.`;

export const dueTimeInThePastMessage =
  "The due time is in the past, so no Schedule was set. Tell the Owner that the time has passed and ask for a time in the future.";

export const noDueGivenMessage = `Neither a local due time nor a repeat rule was given, so no Schedule was set. Ask the Owner when the Schedule is due, and call ${setScheduleToolName} again.`;

export const dueAndRepeatGivenMessage = `Both a local due time and a repeat rule were given, so no Schedule was set. Give only one of them and call ${setScheduleToolName} again.`;

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
});

const failureMessageOf = (cause: Cause.Cause<unknown>) =>
  noteToolFailureMessage(cause, {
    unknownNotesConsequence: "No Schedule was set.",
    otherwise: scheduleNotSetMessage,
  });

export const setScheduleTool = (
  { schedules, alarm, ownerTimeZone, progress, redactor }: ScheduleToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Set a Schedule for the Owner, one-time with localDueTime or repeating with repeat. The action says what happens at the due time. With SendText, the saved text is sent to the Owner in the chat; use it for fixed words for the Owner, such as a Reminder. Give times as the local time of the Owner. Fails with a message when the time zone is not known, neither or both of localDueTime and repeat are given, the time is in the past, or the time is not real. Say that the Schedule is set only after it succeeded, and give the local date, weekday, and time of the first due time that it returns, and for a repeating Schedule how it repeats.",
    inputSchema: effectInputSchema(SetScheduleInput),
    execute: (
      { action, localDueTime, repeat, noteId },
      { toolCallId, modelStepKey }
    ) =>
      Effect.gen(function* setScheduleEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const schedule = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: setScheduleToolName,
            input: {
              action,
              ...(localDueTime === undefined ? {} : { localDueTime }),
              ...(repeat === undefined ? {} : { repeat }),
              ...(noteId === undefined ? {} : { noteId }),
            },
            redactor,
          },
          Effect.gen(function* storeScheduleEffect() {
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
            const { schedule: stored, alreadySet } = yield* schedules.set({
              action,
              setBy: "owner",
              noteId,
              dueAt: due.value.dueAt,
              repeat: due.value.repeat,
              sourceEventId: eventId,
            });
            return {
              ...scheduleOf(stored, timeZone.value),
              timeZone: DateTime.zoneToString(timeZone.value),
              alreadySet,
            };
          })
        );
        yield* alarm.rearm;
        return schedule;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            Cause.findErrorOption(cause).pipe(
              Option.filter((error) => error instanceof ToolFailed),
              Option.getOrElse(
                () => new ToolFailed({ message: failureMessageOf(cause) })
              )
            )
          )
        )
      ),
  });
