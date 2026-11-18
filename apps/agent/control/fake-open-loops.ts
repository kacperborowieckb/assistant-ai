import { Option, Schema } from "effect";

export const fakeTodoPrefix = "todo: ";
export const fakeOpenLoopsText = "open loops:";
export const fakeDonePrefix = "done: ";

const KeptTodoSchema = Schema.fromJsonString(
  Schema.Struct({
    noteId: Schema.String,
    text: Schema.String,
    openLoop: Schema.Struct({ state: Schema.String }),
  })
);

const ListedOpenLoopsSchema = Schema.fromJsonString(
  Schema.Struct({
    openLoops: Schema.Array(Schema.Struct({ text: Schema.String })),
    openLoopCount: Schema.Number,
  })
);

const FoundNotesSchema = Schema.fromJsonString(
  Schema.Struct({
    notes: Schema.Array(
      Schema.Struct({ noteId: Schema.String, text: Schema.String })
    ),
  })
);

const ClosedLoopSchema = Schema.fromJsonString(
  Schema.Struct({
    noteId: Schema.String,
    openLoop: Schema.Struct({ state: Schema.Literal("closed") }),
  })
);

const decodeKeptTodo = Schema.decodeUnknownOption(KeptTodoSchema);
const decodeListed = Schema.decodeUnknownOption(ListedOpenLoopsSchema);
const decodeFound = Schema.decodeUnknownOption(FoundNotesSchema);
const decodeClosed = Schema.decodeUnknownOption(ClosedLoopSchema);

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

export const isFakeOpenLoopRequest = (ownerText: string) =>
  ownerText.startsWith(fakeTodoPrefix) ||
  ownerText === fakeOpenLoopsText ||
  ownerText.startsWith(fakeDonePrefix);

const fakeTodoMessage = (ownerText: string, toolResult: string | undefined) => {
  if (toolResult === undefined) {
    return toolCall("capture_note", {
      text: ownerText.slice(fakeTodoPrefix.length),
      openLoop: { kind: "task" },
    });
  }
  const kept = decodeKeptTodo(toolResult);
  return say(
    Option.isSome(kept)
      ? `Kept open loop ${kept.value.noteId}: ${kept.value.text} (${kept.value.openLoop.state})`
      : "Sorry, I could not keep that."
  );
};

const fakeListMessage = (toolResult: string | undefined) => {
  if (toolResult === undefined) {
    return toolCall("list_open_loops", {});
  }
  const listed = decodeListed(toolResult);
  if (Option.isNone(listed)) {
    return say("Sorry, I could not look in my Notes.");
  }
  const [first] = listed.value.openLoops;
  return say(
    `Open loops: ${listed.value.openLoopCount}, first: ${first?.text ?? "none"}`
  );
};

const fakeDoneMessage = (ownerText: string, toolResult: string | undefined) => {
  if (toolResult === undefined) {
    return toolCall("search_notes", {
      query: ownerText.slice(fakeDonePrefix.length),
    });
  }
  const found = decodeFound(toolResult);
  if (Option.isSome(found)) {
    const [best] = found.value.notes;
    return best === undefined
      ? say("I do not know.")
      : toolCall("close_open_loop", { noteId: best.noteId, reason: "done" });
  }
  const closed = decodeClosed(toolResult);
  return say(
    Option.isSome(closed)
      ? `Closed open loop ${closed.value.noteId}`
      : "Sorry, I could not close that."
  );
};

export const fakeOpenLoopMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  if (ownerText.startsWith(fakeTodoPrefix)) {
    return fakeTodoMessage(ownerText, toolResult);
  }
  return ownerText === fakeOpenLoopsText
    ? fakeListMessage(toolResult)
    : fakeDoneMessage(ownerText, toolResult);
};
