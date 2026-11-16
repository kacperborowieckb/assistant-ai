import { DateTime, Effect, Option, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import {
  instantOfLocalDueTime,
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
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
  "Neither a new text nor a new local due time was given, so nothing was changed. Ask the Owner what to change.";

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
        description: `The new local date and time of the Owner when the Reminder is due, as ${localDueTimeFormat} with no time zone or offset. Leave it out to keep the old time. Work it out from the current local time that you were given.`,
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
      "Change the text, the local due time, or both of an active Reminder of the Owner. The Reminder fires at the new time and not at the old time. Fails with a message, and changes nothing, when no active Reminder has the id, the time zone is not known, the new time is in the past, or the new time is not real. Say that the Reminder is changed only after this succeeded, and give the local date, weekday, and time that it returns.",
    inputSchema: effectInputSchema(ChangeReminderInput),
    execute: (
      { scheduleId, text, localDueTime },
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
            },
            redactor,
          },
          Effect.gen(function* changeScheduleEffect() {
            if (text === undefined && localDueTime === undefined) {
              return yield* new ToolFailed({ message: nothingToChangeMessage });
            }
            const timeZone = yield* ownerTimeZone;
            if (Option.isNone(timeZone)) {
              return yield* new ToolFailed({
                message: noTimeZoneForChangeMessage,
              });
            }
            const dueAt =
              localDueTime === undefined
                ? Option.none<DateTime.Utc>()
                : instantOfLocalDueTime(localDueTime, timeZone.value);
            if (localDueTime !== undefined && Option.isNone(dueAt)) {
              return yield* new ToolFailed({
                message: invalidNewDueTimeMessage,
              });
            }
            if (
              Option.isSome(dueAt) &&
              DateTime.isLessThanOrEqualTo(dueAt.value, yield* DateTime.now)
            ) {
              return yield* new ToolFailed({
                message: newDueTimeInThePastMessage,
              });
            }
            const result = yield* schedules.change({
              scheduleId,
              kind: "reminder",
              text,
              dueAt: Option.getOrUndefined(dueAt),
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
