import { Option, Schema } from "effect";

export const fakeChangePrefix = "change: ";
export const fakeLinkPrefix = "link: ";
export const fakeLinkedPrefix = "linked: ";
const separator = " => ";

const FoundNotesSchema = Schema.fromJsonString(
  Schema.Struct({
    notes: Schema.Array(Schema.Struct({ noteId: Schema.String })),
  })
);

const WrittenNoteSchema = Schema.fromJsonString(
  Schema.Struct({
    noteId: Schema.String,
    text: Schema.String,
    linkedNoteIds: Schema.Array(Schema.String),
  })
);

const ListedNotesSchema = Schema.fromJsonString(
  Schema.Struct({
    linkedNotes: Schema.Array(Schema.Struct({ text: Schema.String })),
    linkedNoteCount: Schema.Number,
  })
);

const decodeListedNotes = Schema.decodeUnknownOption(ListedNotesSchema);

const decodeFoundNotes = Schema.decodeUnknownOption(FoundNotesSchema);
const decodeWrittenNote = Schema.decodeUnknownOption(WrittenNoteSchema);

const toolCall = (name: string, input: Record<string, unknown>) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: `call-${name}-1`,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    },
  ],
});

const say = (content: string) => ({ role: "assistant", content });

export const isFakeNoteEdit = (ownerText: string) =>
  ownerText.startsWith(fakeChangePrefix) ||
  ownerText.startsWith(fakeLinkPrefix) ||
  ownerText.startsWith(fakeLinkedPrefix);

const fakeLinkedNotesMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  if (toolResult === undefined) {
    return toolCall("search_notes", {
      query: ownerText.slice(fakeLinkedPrefix.length),
    });
  }
  const listed = decodeListedNotes(toolResult);
  if (Option.isSome(listed)) {
    const [newest] = listed.value.linkedNotes;
    return say(
      `Linked: ${listed.value.linkedNoteCount} Note, newest: ${newest?.text ?? "none"}`
    );
  }
  const found = decodeFoundNotes(toolResult);
  const [best] = Option.isSome(found) ? found.value.notes : [];
  return best === undefined
    ? say("I do not know.")
    : toolCall("list_linked_notes", { noteId: best.noteId });
};

export const fakeNoteEditMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  if (ownerText.startsWith(fakeLinkedPrefix)) {
    return fakeLinkedNotesMessage(ownerText, toolResult);
  }
  const isChange = ownerText.startsWith(fakeChangePrefix);
  const prefix = isChange ? fakeChangePrefix : fakeLinkPrefix;
  const [searched = "", ...textParts] = ownerText
    .slice(prefix.length)
    .split(separator);
  const newText = textParts.join(separator);
  if (toolResult === undefined) {
    return toolCall("search_notes", { query: searched });
  }
  const found = decodeFoundNotes(toolResult);
  if (Option.isSome(found)) {
    const [best] = found.value.notes;
    if (best === undefined) {
      return say("I do not know.");
    }
    return isChange
      ? toolCall("update_note", { noteId: best.noteId, text: newText })
      : toolCall("capture_note", {
          text: newText,
          linkedNoteIds: [best.noteId],
        });
  }
  const written = decodeWrittenNote(toolResult);
  if (Option.isNone(written)) {
    return say("Sorry, I could not do that.");
  }
  const { noteId, text, linkedNoteIds } = written.value;
  return say(
    isChange
      ? `Changed note ${noteId}: ${text}`
      : `Kept note ${noteId}: ${text} (linked to ${linkedNoteIds.length} Note)`
  );
};
