import { Cause, Effect, Option, Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { ScheduleAlarm } from "../schedule/schedule-alarm.ts";
import type { Schedules } from "../schedule/schedules.ts";
import { namedTimeZone } from "../time/time-zone.ts";
import type { Redactor } from "../tracing/redactor.ts";
import { InvalidTimeZone } from "./invalid-time-zone.ts";
import type { OwnerPreferences } from "./owner-preferences.ts";

export const setTimeZoneToolName = "set_time_zone";

export const timeZoneNotChangedMessage =
  "The time zone was not changed. Tell the Owner that you could not change it.";

export interface PreferenceToolServices {
  readonly preferences: OwnerPreferences["Service"];
  readonly schedules: Schedules["Service"];
  readonly alarm: ScheduleAlarm["Service"];
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}

const SetTimeZoneInput = Schema.Struct({
  timeZone: Schema.String.pipe(
    Schema.annotate({
      description:
        "The IANA time zone name of the Owner, for example Europe/Warsaw or America/New_York. Derive it from the place where the Owner lives or from the name that they give.",
    })
  ),
});

const failureMessageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && error.value instanceof InvalidTimeZone) {
    return `${JSON.stringify(error.value.name)} is not an IANA time zone name. The time zone was not changed. Tell the Owner that you could not set it, and ask for their city or an IANA name such as Europe/Warsaw.`;
  }
  return timeZoneNotChangedMessage;
};

export const setTimeZoneTool = (
  { preferences, schedules, alarm, progress, redactor }: PreferenceToolServices,
  eventId: string
) =>
  agentTool({
    description:
      "Set the time zone of the Owner. It decides the local date and time that you see in every Turn, and the repeating Reminders keep their local time in the new time zone. Call it when the Owner says where they live or gives their time zone, also when they change it. Fails with a message when the name is not an IANA time zone name, and then nothing changes.",
    inputSchema: effectInputSchema(SetTimeZoneInput),
    execute: ({ timeZone }, { toolCallId, modelStepKey }) =>
      Effect.gen(function* setTimeZoneEffect() {
        yield* progress.markModelStep(eventId, modelStepKey);
        const change = yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: setTimeZoneToolName,
            input: { timeZone },
            redactor,
          },
          Effect.gen(function* changeTimeZoneEffect() {
            const result = yield* preferences.setTimeZone(timeZone, eventId);
            const zone = namedTimeZone(result.timeZone);
            if (Option.isSome(zone)) {
              yield* schedules.moveRepeatingToTimeZone(zone.value, eventId);
            }
            return result;
          })
        );
        yield* alarm.rearm;
        return change;
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
