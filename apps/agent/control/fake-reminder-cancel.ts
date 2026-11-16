import { Option, Schema } from "effect";

export const fakeCancelReminderPrefix = "cancel reminder: ";

const ListedRemindersSchema = Schema.fromJsonString(
  Schema.Struct({
    reminders: Schema.Array(
      Schema.Struct({ scheduleId: Schema.String, text: Schema.String })
    ),
  })
);

const CancelledReminderSchema = Schema.fromJsonString(
  Schema.Struct({
    text: Schema.String,
    state: Schema.Literal("cancelled"),
  })
);

const decodeListed = Schema.decodeUnknownOption(ListedRemindersSchema);
const decodeCancelled = Schema.decodeUnknownOption(CancelledReminderSchema);

const toolCall = (id: string, name: string, input: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    },
  ],
});

export const fakeCancelReminderMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  const words = ownerText.slice(fakeCancelReminderPrefix.length);
  if (toolResult === undefined) {
    return toolCall("call-cancel-list-1", "list_reminders", {});
  }
  const cancelled = decodeCancelled(toolResult);
  if (Option.isSome(cancelled)) {
    return {
      role: "assistant",
      content: `Cancelled Reminder: ${cancelled.value.text}`,
    };
  }
  const match = decodeListed(toolResult).pipe(
    Option.flatMapNullishOr(({ reminders }) =>
      reminders.find(({ text }) => text.includes(words))
    )
  );
  return Option.isSome(match)
    ? toolCall("call-cancel-1", "cancel_reminder", {
        scheduleId: match.value.scheduleId,
      })
    : { role: "assistant", content: `No Reminder matches: ${words}` };
};
