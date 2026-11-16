import { Option, Schema } from "effect";

export const fakeReminderPrefix = "remind: ";

const SetReminderResultSchema = Schema.fromJsonString(
  Schema.Struct({ due: Schema.String, timeZone: Schema.String })
);

const decodeSetReminderResult = Schema.decodeUnknownOption(
  SetReminderResultSchema
);

const currentLocalTime =
  /Current local time of the Owner: \S+ (?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}), (?<hour>\d{2}):(?<minute>\d{2})/u;

const twoDigits = (value: number) => String(value).padStart(2, "0");

const nextLocalMinute = (systemText: string) =>
  Option.fromNullishOr(currentLocalTime.exec(systemText)?.groups).pipe(
    Option.map(({ year, month, day, hour, minute }) => {
      const next = new Date(
        Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute)
        ) + 60_000
      );
      return `${next.getUTCFullYear()}-${twoDigits(next.getUTCMonth() + 1)}-${twoDigits(next.getUTCDate())}T${twoDigits(next.getUTCHours())}:${twoDigits(next.getUTCMinutes())}`;
    })
  );

export const fakeReminderMessage = (
  ownerText: string,
  toolResult: string | undefined,
  systemText: string
) => {
  if (toolResult === undefined) {
    const localDueTime = nextLocalMinute(systemText);
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-reminder-1",
          type: "function",
          function: {
            name: "set_reminder",
            arguments: JSON.stringify({
              text: ownerText.slice(fakeReminderPrefix.length),
              localDueTime: Option.getOrElse(localDueTime, () => ""),
            }),
          },
        },
      ],
    };
  }
  const set = decodeSetReminderResult(toolResult);
  return {
    role: "assistant",
    content: Option.isSome(set)
      ? `Reminder set for ${set.value.due} (${set.value.timeZone})`
      : "Sorry, I could not set that Reminder.",
  };
};
