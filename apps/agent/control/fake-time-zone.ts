import { Option, Schema } from "effect";

export const fakeZonePrefix = "zone: ";
export const fakeTimeQuestion = "time?";

const SetZoneSchema = Schema.fromJsonString(
  Schema.Struct({ timeZone: Schema.String, changed: Schema.Boolean })
);

const decodeSetZone = Schema.decodeUnknownOption(SetZoneSchema);

const currentTimeLine = /Current local time of the Owner: [^\n]+/u;

export const isFakeTimeZoneMessage = (ownerText: string) =>
  ownerText.startsWith(fakeZonePrefix) || ownerText === fakeTimeQuestion;

export const fakeTimeZoneMessage = (
  ownerText: string,
  toolResult: string | undefined,
  systemText: string
) => {
  if (ownerText === fakeTimeQuestion) {
    return {
      role: "assistant",
      content:
        currentTimeLine.exec(systemText)?.[0] ?? "The time zone is not known.",
    };
  }
  if (toolResult === undefined) {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-zone-1",
          type: "function",
          function: {
            name: "set_time_zone",
            arguments: JSON.stringify({
              timeZone: ownerText.slice(fakeZonePrefix.length),
            }),
          },
        },
      ],
    };
  }
  const set = decodeSetZone(toolResult);
  return {
    role: "assistant",
    content: Option.isSome(set)
      ? `Time zone set: ${set.value.timeZone}`
      : "Sorry, I could not set that time zone.",
  };
};
