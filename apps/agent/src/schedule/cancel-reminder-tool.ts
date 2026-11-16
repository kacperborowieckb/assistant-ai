import { Effect, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { noActiveReminderMessage } from "./reminder-presentation.ts";
import { failWithToolMessage } from "./reminder-tool-failure.ts";
import type { ReminderToolServices } from "./reminder-tool-services.ts";
import { textOfAction } from "./schedule-action.ts";

export const cancelReminderToolName = "cancel_reminder";

export const reminderNotCancelledMessage =
  "The Reminder was not cancelled. Tell the Owner that you could not cancel it.";

const CancelReminderInput = Schema.Struct({
  scheduleId: Schema.String.pipe(
    Schema.annotate({
      description:
        "The id of the active Reminder to cancel, from list_reminders or set_reminder.",
    })
  ),
});

export const cancelReminderTool = (
  { schedules, alarm, progress, redactor }: ReminderToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Cancel an active Reminder of the Owner. A cancelled Reminder never fires. Fails with a message, and changes nothing, when no active Reminder has the id. Say that the Reminder is cancelled only after this succeeded.",
    inputSchema: effectInputSchema(CancelReminderInput),
    execute: ({ scheduleId }, { toolCallId, modelStepKey }) =>
      Effect.gen(function* cancelReminderEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const cancelled = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: cancelReminderToolName,
            input: { scheduleId },
            redactor,
          },
          Effect.gen(function* cancelScheduleEffect() {
            const result = yield* schedules.cancel({
              scheduleId,
              actionTag: "SendText",
              eventId,
            });
            if (result._tag === "None") {
              return yield* new ToolFailed({
                message: noActiveReminderMessage(scheduleId),
              });
            }
            return {
              scheduleId,
              text: textOfAction(result.value.action),
              state: result.value.state,
            };
          })
        );
        yield* alarm.rearm;
        return cancelled;
      }).pipe(failWithToolMessage(reminderNotCancelledMessage)),
  });
