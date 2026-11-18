import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { noActiveScheduleMessage } from "./schedule-presentation.ts";
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
  { schedules, progress, redactor }: ScheduleToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: cancelScheduleToolName,
      description:
        "Cancel an active Schedule of the Owner. A cancelled Schedule never fires. Fails with a message, and changes nothing, when no active Schedule has the id. Say that the Schedule is cancelled only after this succeeded.",
      inputSchema: CancelScheduleInput,
      failureMessage: scheduleNotCancelledMessage,
      work: Effect.fnUntraced(function* cancelActiveEffect({ scheduleId }) {
        const result = yield* schedules.cancel({ scheduleId, eventId });
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
      }),
    }
  );
