import { Option, Schema } from "effect";

export const fakeKeepPrefix = "keep: ";

const KeptNoteSchema = Schema.fromJsonString(
  Schema.Struct({ noteId: Schema.String, text: Schema.String })
);

const decodeKeptNote = Schema.decodeUnknownOption(KeptNoteSchema);

export const fakeKeepMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  if (toolResult === undefined) {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-keep-1",
          type: "function",
          function: {
            name: "capture_note",
            arguments: JSON.stringify({
              text: ownerText.slice(fakeKeepPrefix.length),
            }),
          },
        },
      ],
    };
  }
  const kept = decodeKeptNote(toolResult);
  return {
    role: "assistant",
    content: Option.isSome(kept)
      ? `Kept note ${kept.value.noteId}: ${kept.value.text}`
      : "Sorry, I could not keep that.",
  };
};
