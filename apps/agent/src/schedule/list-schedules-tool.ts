import { DateTime, Effect, Option, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import { scheduleOf } from "./schedule-presentation.ts";
import { failWithToolMessage } from "./schedule-tool-failure.ts";
import type { ScheduleToolServices } from "./schedule-tool-services.ts";

export const listSchedulesToolName = "list_schedules";

export const schedulesNotListedMessage =
  "The Schedules could not be listed. Tell the Owner that you could not look at their Schedules.";

export const noTimeZoneForListMessage = `The time zone of the Owner is not known, so the Schedules cannot be shown in local time. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then list the Schedules.`;

export const listSchedulesTool = (
  { schedules, ownerTimeZone, progress, redactor }: ScheduleToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "List the active Schedules of the Owner, the earliest first. Each has its id, its Action (SendText with its text), optional Note id, and local due weekday, date, and time. A Schedule that is done or cancelled is not listed. An empty list means that the Owner has no active Schedule.",
    inputSchema: effectInputSchema(Schema.Struct({})),
    execute: (_input, { toolCallId, modelStepKey }) =>
      Effect.gen(function* listSchedulesEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        return yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: listSchedulesToolName,
            input: {},
            redactor,
          },
          Effect.gen(function* listActiveEffect() {
            const timeZone = yield* ownerTimeZone;
            if (Option.isNone(timeZone)) {
              return yield* new ToolFailed({
                message: noTimeZoneForListMessage,
              });
            }
            const active = yield* schedules.listActive("SendText");
            return {
              timeZone: DateTime.zoneToString(timeZone.value),
              schedules: active.map((schedule) =>
                scheduleOf(schedule, timeZone.value)
              ),
            };
          })
        );
      }).pipe(failWithToolMessage(schedulesNotListedMessage)),
  });
