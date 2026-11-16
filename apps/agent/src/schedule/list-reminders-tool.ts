import { DateTime, Effect, Option, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import { reminderOf } from "./reminder-presentation.ts";
import { failWithToolMessage } from "./reminder-tool-failure.ts";
import type { ReminderToolServices } from "./reminder-tool-services.ts";

export const listRemindersToolName = "list_reminders";

export const remindersNotListedMessage =
  "The Reminders could not be listed. Tell the Owner that you could not look at their Reminders.";

export const noTimeZoneForListMessage = `The time zone of the Owner is not known, so the Reminders cannot be shown in local time. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then list the Reminders.`;

export const listRemindersTool = (
  { schedules, ownerTimeZone, progress, redactor }: ReminderToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "List the active Reminders of the Owner, the earliest first. Each has its id, text, optional Note id, and local due weekday, date, and time. A Reminder that is done or cancelled is not listed. An empty list means that the Owner has no active Reminder.",
    inputSchema: effectInputSchema(Schema.Struct({})),
    execute: (_input, { toolCallId, modelStepKey }) =>
      Effect.gen(function* listRemindersEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        return yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: listRemindersToolName,
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
              reminders: active.map((schedule) =>
                reminderOf(schedule, timeZone.value)
              ),
            };
          })
        );
      }).pipe(failWithToolMessage(remindersNotListedMessage)),
  });
