import { Effect, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { noActiveScheduleMessage } from "./schedule-presentation.ts";
import { failWithToolMessage } from "./schedule-tool-failure.ts";
import type { ScheduleToolServices } from "./schedule-tool-services.ts";

export const cancelScheduleToolName = "cancel_schedule";

export const scheduleNotCancelledMessage =
  "The Schedule was not cancelled. Tell the Owner that you could not cancel it.";

const CancelScheduleInput = Schema.Struct({
  scheduleId: Schema.String.pipe(
    Schema.annotate({
      description:
        "The id of the active Schedule to cancel, from list_schedules or set_schedule.",
    })
  ),
});

export const cancelScheduleTool = (
  { schedules, alarm, progress, redactor }: ScheduleToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Cancel an active Schedule of the Owner. A cancelled Schedule never fires. Fails with a message, and changes nothing, when no active Schedule has the id. Say that the Schedule is cancelled only after this succeeded.",
    inputSchema: effectInputSchema(CancelScheduleInput),
    execute: ({ scheduleId }, { toolCallId, modelStepKey }) =>
      Effect.gen(function* cancelScheduleEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const cancelled = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: cancelScheduleToolName,
            input: { scheduleId },
            redactor,
          },
          Effect.gen(function* cancelActiveEffect() {
            const result = yield* schedules.cancel({
              scheduleId,
              eventId,
            });
            if (result._tag === "None") {
              return yield* new ToolFailed({
                message: noActiveScheduleMessage(scheduleId),
              });
            }
            return {
              scheduleId,
              action: result.value.action,
              state: result.value.state,
            };
          })
        );
        yield* alarm.rearm;
        return cancelled;
      }).pipe(failWithToolMessage(scheduleNotCancelledMessage)),
  });
