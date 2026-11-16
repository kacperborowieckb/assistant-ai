import { DateTime, Effect, Option, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import {
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
import { RecurrenceRuleSchema } from "../time/recurrence-rule.ts";
import { resolveReminderDue } from "./reminder-due.ts";
import {
  noActiveReminderMessage,
  reminderOf,
} from "./reminder-presentation.ts";
import { failWithToolMessage } from "./reminder-tool-failure.ts";
import type { ReminderToolServices } from "./reminder-tool-services.ts";

export const changeReminderToolName = "change_reminder";

export const reminderNotChangedMessage =
  "The Reminder was not changed. Tell the Owner that you could not change it.";

export const nothingToChangeMessage =
  "Neither a new text, a new local due time, nor a new repeat rule was given, so nothing was changed. Ask the Owner what to change.";

export const newDueAndRepeatGivenMessage = `Both a new local due time and a new repeat rule were given, so the Reminder was not changed. Give only one of them and call ${changeReminderToolName} again.`;

export const noTimeZoneForChangeMessage = `The time zone of the Owner is not known, so the Reminder was not changed. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then change the Reminder.`;

export const invalidNewDueTimeMessage = `The new due time is not a real local date and time in the form ${localDueTimeFormat}. The Reminder was not changed. Check the date and call ${changeReminderToolName} again.`;

export const newDueTimeInThePastMessage =
  "The new due time is in the past, so the Reminder was not changed. Tell the Owner that the time has passed and ask for a time in the future.";

const ChangeReminderInput = Schema.Struct({
  scheduleId: Schema.String.pipe(
    Schema.annotate({
      description:
        "The id of the active Reminder to change, from list_reminders or set_reminder.",
    })
  ),
  text: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(Schema.isPattern(/\S/u)),
      Schema.annotate({
        description:
          "The new message to send to the Owner at the due time. Leave it out to keep the old text.",
      })
    )
  ),
  localDueTime: Schema.optionalKey(
    LocalDueTimeSchema.pipe(
      Schema.annotate({
        description: `The new local date and time of the Owner when the Reminder is due once, as ${localDueTimeFormat} with no time zone or offset. A repeating Reminder becomes a one-time Reminder. Leave it out to keep the old time. Work it out from the current local time that you were given.`,
      })
    )
  ),
  repeat: Schema.optionalKey(
    RecurrenceRuleSchema.pipe(
      Schema.annotate({
        description:
          "The new repeat rule in the local time of the Owner. A one-time Reminder becomes a repeating Reminder. Leave it out to keep the old time or rule.",
      })
    )
  ),
});

export const changeReminderTool = (
  { schedules, alarm, ownerTimeZone, progress, redactor }: ReminderToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Change the text, the local due time or the repeat rule, or both the text and one of those, of an active Reminder of the Owner. The Reminder fires at the new time and not at the old time. Fails with a message, and changes nothing, when no active Reminder has the id, the time zone is not known, the new time is in the past, or the new time is not real. Say that the Reminder is changed only after this succeeded, and give the local date, weekday, and time that it returns.",
    inputSchema: effectInputSchema(ChangeReminderInput),
    execute: (
      { scheduleId, text, localDueTime, repeat },
      { toolCallId, modelStepKey }
    ) =>
      Effect.gen(function* changeReminderEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const changed = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: changeReminderToolName,
            input: {
              scheduleId,
              ...(text === undefined ? {} : { text }),
              ...(localDueTime === undefined ? {} : { localDueTime }),
              ...(repeat === undefined ? {} : { repeat }),
            },
            redactor,
          },
          Effect.gen(function* changeScheduleEffect() {
            if (
              text === undefined &&
              localDueTime === undefined &&
              repeat === undefined
            ) {
              return yield* new ToolFailed({ message: nothingToChangeMessage });
            }
            const timeZone = yield* ownerTimeZone;
            if (Option.isNone(timeZone)) {
              return yield* new ToolFailed({
                message: noTimeZoneForChangeMessage,
              });
            }
            const due = yield* resolveReminderDue(
              { localDueTime, repeat },
              timeZone.value,
              {
                bothGiven: newDueAndRepeatGivenMessage,
                invalidLocalDueTime: invalidNewDueTimeMessage,
                localDueTimeInThePast: newDueTimeInThePastMessage,
              }
            );
            const result = yield* schedules.change({
              scheduleId,
              kind: "reminder",
              text,
              dueAt: due.pipe(
                Option.map(({ dueAt }) => dueAt),
                Option.getOrUndefined
              ),
              repeat: due.pipe(
                Option.flatMap(({ repeat: next }) =>
                  Option.fromNullishOr(next)
                ),
                Option.getOrUndefined
              ),
              eventId,
            });
            if (result._tag === "None") {
              return yield* new ToolFailed({
                message: noActiveReminderMessage(scheduleId),
              });
            }
            return {
              ...reminderOf(result.value, timeZone.value),
              timeZone: DateTime.zoneToString(timeZone.value),
            };
          })
        );
        yield* alarm.rearm;
        return changed;
      }).pipe(failWithToolMessage(reminderNotChangedMessage)),
  });
