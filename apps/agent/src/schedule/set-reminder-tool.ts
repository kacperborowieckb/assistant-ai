import { Cause, DateTime, Effect, Option, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { noteToolFailureMessage } from "../notes/note-tool-failure-message.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import {
  instantOfLocalDueTime,
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
import { localTimeOf } from "../time/local-time.ts";
import type { ReminderToolServices } from "./reminder-tool-services.ts";

export const setReminderToolName = "set_reminder";

export const reminderNotSetMessage =
  "The Reminder was not set. Tell the Owner that you could not set it.";

export const noTimeZoneForReminderMessage = `The time zone of the Owner is not known, so no Reminder was set. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then set the Reminder.`;

export const invalidLocalDueTimeMessage = `The due time is not a real local date and time in the form ${localDueTimeFormat}. No Reminder was set. Check the date and call ${setReminderToolName} again.`;

export const dueTimeInThePastMessage =
  "The due time is in the past, so no Reminder was set. Tell the Owner that the time has passed and ask for a time in the future.";

const SetReminderInput = Schema.Struct({
  text: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The message to send to the Owner at the due time. Write it so that it is clear on its own, for example: Buy the gift for Ana.",
    })
  ),
  localDueTime: LocalDueTimeSchema.pipe(
    Schema.annotate({
      description: `The local date and time of the Owner when the Reminder is due, as ${localDueTimeFormat} with no time zone or offset, for example 2026-11-19T09:00. Work it out from the current local time that you were given.`,
    })
  ),
  noteId: Schema.optionalKey(
    Schema.String.pipe(
      Schema.annotate({
        description:
          "The id of the Note that this Reminder is about, when the Owner asked for the Reminder together with something to keep. Use an id that capture_note or search_notes returned.",
      })
    )
  ),
});

const failureMessageOf = (cause: Cause.Cause<unknown>) =>
  noteToolFailureMessage(cause, {
    unknownNotesConsequence: "No Reminder was set.",
    otherwise: reminderNotSetMessage,
  });

export const setReminderTool = (
  { schedules, alarm, ownerTimeZone, progress, redactor }: ReminderToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Set a one-time Reminder for the Owner. At the due time the saved text is sent to the Owner in the chat. Give the due time as the local time of the Owner. Fails with a message when the time zone is not known, the time is in the past, or the time is not real. Say that the Reminder is set only after it succeeded, and give the local date, weekday, and time that it returns.",
    inputSchema: effectInputSchema(SetReminderInput),
    execute: ({ text, localDueTime, noteId }, { toolCallId, modelStepKey }) =>
      Effect.gen(function* setReminderEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const reminder = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: setReminderToolName,
            input: {
              text,
              localDueTime,
              ...(noteId === undefined ? {} : { noteId }),
            },
            redactor,
          },
          Effect.gen(function* setScheduleEffect() {
            const timeZone = yield* ownerTimeZone;
            if (Option.isNone(timeZone)) {
              return yield* new ToolFailed({
                message: noTimeZoneForReminderMessage,
              });
            }
            const dueAt = instantOfLocalDueTime(localDueTime, timeZone.value);
            if (Option.isNone(dueAt)) {
              return yield* new ToolFailed({
                message: invalidLocalDueTimeMessage,
              });
            }
            if (
              DateTime.isLessThanOrEqualTo(dueAt.value, yield* DateTime.now)
            ) {
              return yield* new ToolFailed({
                message: dueTimeInThePastMessage,
              });
            }
            const { schedule, alreadySet } = yield* schedules.set({
              kind: "reminder",
              setBy: "owner",
              text,
              noteId,
              dueAt: dueAt.value,
              sourceEventId: eventId,
            });
            return {
              scheduleId: schedule.scheduleId,
              text: schedule.text,
              noteId: schedule.noteId ?? null,
              due: localTimeOf(schedule.nextDueAt, timeZone.value),
              timeZone: DateTime.zoneToString(timeZone.value),
              alreadySet,
            };
          })
        );
        yield* alarm.rearm;
        return reminder;
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
