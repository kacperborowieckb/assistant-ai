import { Option, Schema } from "effect";

export const fakeRecallPrefix = "recall: ";

const RecalledNotesSchema = Schema.fromJsonString(
  Schema.Struct({
    notes: Schema.Array(
      Schema.Struct({
        text: Schema.String,
        capturedAt: Schema.String,
        source: Schema.Struct({ channelMessageId: Schema.String }),
      })
    ),
  })
);

const decodeRecalledNotes = Schema.decodeUnknownOption(RecalledNotesSchema);

export const fakeRecallMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  if (toolResult === undefined) {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-recall-1",
          type: "function",
          function: {
            name: "search_notes",
            arguments: JSON.stringify({
              query: ownerText.slice(fakeRecallPrefix.length),
            }),
          },
        },
      ],
    };
  }
  const recalled = decodeRecalledNotes(toolResult);
  if (Option.isNone(recalled)) {
    return {
      role: "assistant",
      content: "Sorry, I could not look in my Notes.",
    };
  }
  const [best] = recalled.value.notes;
  return {
    role: "assistant",
    content:
      best === undefined
        ? "I do not know."
        : `Recalled: ${best.text} (Telegram message ${best.source.channelMessageId}, ${best.capturedAt.slice(0, 10)})`,
  };
};
