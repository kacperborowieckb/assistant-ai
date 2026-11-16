import { DateTime, Option, Schema } from "effect";

export const fakeReminderPrefix = "remind: ";

export const fakeRepeatingReminderPrefix = "remind daily: ";

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
      const next = DateTime.toParts(
        DateTime.add(
          DateTime.makeUnsafe({
            year: Number(year),
            month: Number(month),
            day: Number(day),
            hour: Number(hour),
            minute: Number(minute),
          }),
          { minutes: 1 }
        )
      );
      return `${next.year}-${twoDigits(next.month)}-${twoDigits(next.day)}T${twoDigits(next.hour)}:${twoDigits(next.minute)}`;
    })
  );

export const fakeReminderMessage = (
  ownerText: string,
  toolResult: string | undefined,
  systemText: string
) => {
  if (toolResult === undefined) {
    const isRepeating = ownerText.startsWith(fakeRepeatingReminderPrefix);
    const localDueTime = Option.getOrElse(
      nextLocalMinute(systemText),
      () => ""
    );
    const text = ownerText.slice(
      (isRepeating ? fakeRepeatingReminderPrefix : fakeReminderPrefix).length
    );
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-reminder-1",
          type: "function",
          function: {
            name: "set_schedule",
            arguments: JSON.stringify(
              isRepeating
                ? {
                    action: { _tag: "SendText", text },
                    repeat: { _tag: "Daily", time: localDueTime.slice(-5) },
                  }
                : { action: { _tag: "SendText", text }, localDueTime }
            ),
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
