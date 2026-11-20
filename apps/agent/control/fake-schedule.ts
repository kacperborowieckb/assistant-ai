import { DateTime, Option, Schema } from "effect";

export const fakeReminderPrefix = "remind: ";

export const fakeRepeatingReminderPrefix = "remind daily: ";

export const fakeScheduledTaskPrefix = "task: ";

export const fakeRepeatingScheduledTaskPrefix = "task daily: ";

export const fakeScheduledTaskResultPrefix = "Scheduled task result: ";

const prefixes = [
  fakeReminderPrefix,
  fakeRepeatingReminderPrefix,
  fakeScheduledTaskPrefix,
  fakeRepeatingScheduledTaskPrefix,
] as const;

export const isFakeScheduleRequest = (ownerText: string) =>
  prefixes.some((prefix) => ownerText.startsWith(prefix));

export const fakeScheduledTaskMessage = (prompt: string) => ({
  role: "assistant",
  content: `${fakeScheduledTaskResultPrefix}${prompt}`,
});

const SetReminderResultSchema = Schema.fromJsonString(
  Schema.Struct({ due: Schema.String, timeZone: Schema.String })
);

const decodeSetReminderResult = Schema.decodeUnknownOption(
  SetReminderResultSchema
);

const currentLocalTime =
  /Current local time of the Owner: \S+ (?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}), (?<hour>\d{2}):(?<minute>\d{2})/u;

const twoDigits = (value: number) => String(value).padStart(2, "0");

export const nextLocalMinute = (systemText: string) =>
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

const actionOf = (ownerText: string, prefix: string) => {
  const words = ownerText.slice(prefix.length);
  return fakeScheduledTaskPrefixes.has(prefix)
    ? { _tag: "RunPrompt", prompt: words }
    : { _tag: "SendText", text: words };
};

const fakeScheduledTaskPrefixes: ReadonlySet<string> = new Set([
  fakeScheduledTaskPrefix,
  fakeRepeatingScheduledTaskPrefix,
]);

const repeatingPrefixes: ReadonlySet<string> = new Set([
  fakeRepeatingReminderPrefix,
  fakeRepeatingScheduledTaskPrefix,
]);

export const fakeScheduleMessage = (
  ownerText: string,
  toolResult: string | undefined,
  systemText: string
) => {
  const prefix = prefixes.find((candidate) => ownerText.startsWith(candidate));
  if (prefix === undefined) {
    return { role: "assistant", content: ownerText };
  }
  const isTask = fakeScheduledTaskPrefixes.has(prefix);
  if (toolResult === undefined) {
    const localDueTime = Option.getOrElse(
      nextLocalMinute(systemText),
      () => ""
    );
    const action = actionOf(ownerText, prefix);
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
              repeatingPrefixes.has(prefix)
                ? {
                    action,
                    repeat: { _tag: "Daily", time: localDueTime.slice(-5) },
                  }
                : { action, localDueTime }
            ),
          },
        },
      ],
    };
  }
  const set = decodeSetReminderResult(toolResult);
  const noun = isTask ? "Scheduled task" : "Reminder";
  return {
    role: "assistant",
    content: Option.isSome(set)
      ? `${noun} set for ${set.value.due} (${set.value.timeZone})`
      : `Sorry, I could not set that ${noun}.`,
  };
};
