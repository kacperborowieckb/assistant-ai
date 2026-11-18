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
import { refuseAtScheduledTaskLimit } from "./active-scheduled-task-limit-reached.ts";
import { ScheduleActionInputSchema } from "./schedule-action-input.ts";
import { resolveScheduleDue } from "./schedule-due.ts";
import {
  noActiveScheduleMessage,
  scheduleOf,
} from "./schedule-presentation.ts";
import { failWithToolMessage } from "./schedule-tool-failure.ts";
import type { ScheduleToolServices } from "./schedule-tool-services.ts";

export const changeScheduleToolName = "change_schedule";

export const scheduleNotChangedMessage =
  "The Schedule was not changed. Tell the Owner that you could not change it.";

export const nothingToChangeMessage =
  "Neither a new Action, a new local due time, nor a new repeat rule was given, so nothing was changed. Ask the Owner what to change.";

export const newDueAndRepeatGivenMessage = `Both a new local due time and a new repeat rule were given, so the Schedule was not changed. Give only one of them and call ${changeScheduleToolName} again.`;

export const noTimeZoneForChangeMessage = `The time zone of the Owner is not known, so the Schedule was not changed. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then change the Schedule.`;

export const invalidNewDueTimeMessage = `The new due time is not a real local date and time in the form ${localDueTimeFormat}. The Schedule was not changed. Check the date and call ${changeScheduleToolName} again.`;

export const newDueTimeInThePastMessage =
  "The new due time is in the past, so the Schedule was not changed. Tell the Owner that the time has passed and ask for a time in the future.";

const ChangeScheduleInput = Schema.Struct({
  scheduleId: Schema.String.pipe(
    Schema.annotate({
      description:
        "The id of the active Schedule to change, from list_schedules or set_schedule.",
    })
  ),
  action: Schema.optionalKey(
    ScheduleActionInputSchema.pipe(
      Schema.annotate({
        description:
          "The new Action, for example the new text of a SendText Schedule, the new prompt of a RunPrompt Schedule, or the other kind of Action. Leave it out to keep the old Action.",
      })
    )
  ),
  localDueTime: Schema.optionalKey(
    LocalDueTimeSchema.pipe(
      Schema.annotate({
        description: `The new local date and time of the Owner when the Schedule is due once, as ${localDueTimeFormat} with no time zone or offset. A repeating Schedule becomes a one-time Schedule. Leave it out to keep the old time. Work it out from the current local time that you were given.`,
      })
    )
  ),
  repeat: Schema.optionalKey(
    RecurrenceRuleSchema.pipe(
      Schema.annotate({
        description:
          "The new repeat rule in the local time of the Owner. A one-time Schedule becomes a repeating Schedule. Leave it out to keep the old time or rule.",
      })
    )
  ),
});

export const changeScheduleTool = (
  {
    schedules,
    ownerTimeZone,
    progress,
    redactor,
    maxActiveScheduledTasks,
  }: ScheduleToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Change the Action, the local due time or the repeat rule, or both the Action and one of those, of an active Schedule of the Owner. The Action can change between SendText and RunPrompt, or keep its kind with new text or a new prompt. The Schedule fires at the new time and not at the old time. Fails with a message, and changes nothing, in these cases. No active Schedule has the id. The time zone is not known. The new time is in the past or is not real. The change would make a new Scheduled Task, and the limit of active Scheduled Tasks is reached. Say that the Schedule is changed only after this succeeded, and give the local date, weekday, and time that it returns.",
    inputSchema: effectInputSchema(ChangeScheduleInput),
    execute: (
      { scheduleId, action, localDueTime, repeat },
      { toolCallId, modelStepKey }
    ) =>
      Effect.gen(function* changeScheduleEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const changed = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: changeScheduleToolName,
            input: {
              scheduleId,
              ...(action === undefined ? {} : { action }),
              ...(localDueTime === undefined ? {} : { localDueTime }),
              ...(repeat === undefined ? {} : { repeat }),
            },
            redactor,
          },
          Effect.gen(function* changeActiveEffect() {
            if (
              action === undefined &&
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
            const due = yield* resolveScheduleDue(
              { localDueTime, repeat },
              timeZone.value,
              {
                bothGiven: newDueAndRepeatGivenMessage,
                invalidLocalDueTime: invalidNewDueTimeMessage,
                localDueTimeInThePast: newDueTimeInThePastMessage,
              }
            );
            const result = yield* schedules
              .change({
                scheduleId,
                action,
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
                activeScheduledTaskLimit: maxActiveScheduledTasks,
              })
              .pipe(refuseAtScheduledTaskLimit);
            if (result._tag === "None") {
              return yield* new ToolFailed({
                message: noActiveScheduleMessage(scheduleId),
              });
            }
            return {
              ...scheduleOf(result.value, timeZone.value),
              timeZone: DateTime.zoneToString(timeZone.value),
            };
          })
        );
        return changed;
      }).pipe(failWithToolMessage(scheduleNotChangedMessage)),
  });
