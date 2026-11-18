import { Cause, Effect, Option, Schema } from "effect";

import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { TurnProgress } from "../personal-agent/turn-progress.ts";
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
  { preferences, schedules, progress, redactor }: PreferenceToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: setTimeZoneToolName,
      description:
        "Set the time zone of the Owner. It decides the local date and time that you see in every Turn, and the repeating Reminders keep their local time in the new time zone. Call it when the Owner says where they live or gives their time zone, also when they change it. Fails with a message when the name is not an IANA time zone name, and then nothing changes.",
      inputSchema: SetTimeZoneInput,
      failureMessage: failureMessageOf,
      work: Effect.fnUntraced(function* changeTimeZoneEffect({ timeZone }) {
        const result = yield* preferences.setTimeZone(timeZone, eventId);
        const zone = namedTimeZone(result.timeZone);
        if (Option.isSome(zone)) {
          yield* schedules.moveRepeatingToTimeZone(zone.value, eventId);
        }
        return result;
      }),
    }
  );
