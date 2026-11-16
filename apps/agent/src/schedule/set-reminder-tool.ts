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
import { resolveReminderDue } from "./reminder-due.ts";
import { reminderOf } from "./reminder-presentation.ts";
import type { ReminderToolServices } from "./reminder-tool-services.ts";

export const setReminderToolName = "set_reminder";

export const reminderNotSetMessage =
  "The Reminder was not set. Tell the Owner that you could not set it.";

export const noTimeZoneForReminderMessage = `The time zone of the Owner is not known, so no Reminder was set. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then set the Reminder.`;

export const invalidLocalDueTimeMessage = `The due time is not a real local date and time in the form ${localDueTimeFormat}. No Reminder was set. Check the date and call ${setReminderToolName} again.`;

export const dueTimeInThePastMessage =
  "The due time is in the past, so no Reminder was set. Tell the Owner that the time has passed and ask for a time in the future.";

export const noDueGivenMessage = `Neither a local due time nor a repeat rule was given, so no Reminder was set. Ask the Owner when the Reminder is due, and call ${setReminderToolName} again.`;

export const dueAndRepeatGivenMessage = `Both a local due time and a repeat rule were given, so no Reminder was set. Give only one of them and call ${setReminderToolName} again.`;

const SetReminderInput = Schema.Struct({
  text: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The message to send to the Owner at the due time. Write it so that it is clear on its own, for example: Buy the gift for Ana.",
    })
  ),
  localDueTime: Schema.optionalKey(
    LocalDueTimeSchema.pipe(
      Schema.annotate({
        description: `For a one-time Reminder: the local date and time of the Owner when it is due, as ${localDueTimeFormat} with no time zone or offset, for example 2026-11-19T09:00. Work it out from the current local time that you were given. Leave it out when you give repeat.`,
      })
    )
  ),
  repeat: Schema.optionalKey(
    RecurrenceRuleSchema.pipe(
      Schema.annotate({
        description:
          'For a repeating Reminder: the rule, for example {"_tag":"Weekly","weekdays":["Monday"],"time":"09:00"}, {"_tag":"Daily","time":"08:00"}, or {"_tag":"Monthly","day":"last","time":"18:00"}. The time is the local time of the Owner and stays the same when daylight saving time changes. Leave out localDueTime when you give repeat.',
      })
    )
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
      "Set a Reminder for the Owner, one-time with localDueTime or repeating with repeat. At the due time the saved text is sent to the Owner in the chat. Give times as the local time of the Owner. Fails with a message when the time zone is not known, neither or both of localDueTime and repeat are given, the time is in the past, or the time is not real. Say that the Reminder is set only after it succeeded, and give the local date, weekday, and time of the first due time that it returns, and for a repeating Reminder how it repeats.",
    inputSchema: effectInputSchema(SetReminderInput),
    execute: (
      { text, localDueTime, repeat, noteId },
      { toolCallId, modelStepKey }
    ) =>
      Effect.gen(function* setReminderEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const reminder = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: setReminderToolName,
            input: {
              text,
              ...(localDueTime === undefined ? {} : { localDueTime }),
              ...(repeat === undefined ? {} : { repeat }),
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
            const due = yield* resolveReminderDue(
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
            const { schedule, alreadySet } = yield* schedules.set({
              action: { _tag: "SendText", text },
              setBy: "owner",
              noteId,
              dueAt: due.value.dueAt,
              repeat: due.value.repeat,
              sourceEventId: eventId,
            });
            return {
              ...reminderOf(schedule, timeZone.value),
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
