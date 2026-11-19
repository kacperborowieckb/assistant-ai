import { Option, Schema } from "effect";

export const fakeTodoPrefix = "todo: ";
export const fakeDonePrefix = "done: ";
export const fakeWhatIsOpen = "what is open?";

const OpenLoopSchema = Schema.Struct({ kind: Schema.String });

const KeptOpenLoopSchema = Schema.fromJsonString(
  Schema.Struct({
    noteId: Schema.String,
    text: Schema.String,
    openLoop: OpenLoopSchema,
  })
);

const ListedOpenLoopsSchema = Schema.fromJsonString(
  Schema.Struct({
    openLoops: Schema.Array(
      Schema.Struct({ noteId: Schema.String, text: Schema.String })
    ),
    openLoopCount: Schema.Number,
    nextOffset: Schema.NullOr(Schema.Number),
  })
);

const ClosedOpenLoopSchema = Schema.fromJsonString(
  Schema.Struct({
    text: Schema.String,
    openLoop: Schema.Struct({ state: Schema.String }),
  })
);

const decodeKept = Schema.decodeUnknownOption(KeptOpenLoopSchema);
const decodeListed = Schema.decodeUnknownOption(ListedOpenLoopsSchema);
const decodeClosed = Schema.decodeUnknownOption(ClosedOpenLoopSchema);

const toolCall = (name: string, input: Record<string, unknown>) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: `call-${name}-${JSON.stringify(input)}`,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    },
  ],
});

const say = (content: string) => ({ role: "assistant", content });

export const isFakeOpenLoopMessage = (ownerText: string) =>
  ownerText.startsWith(fakeTodoPrefix) ||
  ownerText.startsWith(fakeDonePrefix) ||
  ownerText === fakeWhatIsOpen;

const fakeTodoMessage = (ownerText: string, toolResult: string | undefined) => {
  if (toolResult === undefined) {
    return toolCall("capture_note", {
      text: ownerText.slice(fakeTodoPrefix.length),
      openLoop: { kind: "task" },
    });
  }
  const kept = decodeKept(toolResult);
  return Option.isSome(kept)
    ? say(
        `Kept open loop ${kept.value.noteId} (${kept.value.openLoop.kind}): ${kept.value.text}`
      )
    : say("Sorry, I could not keep that.");
};

const fakeWhatIsOpenMessage = (toolResult: string | undefined) => {
  if (toolResult === undefined) {
    return toolCall("list_open_loops", {});
  }
  const listed = decodeListed(toolResult);
  return Option.isSome(listed)
    ? say(
        `Open (${listed.value.openLoopCount}): ${listed.value.openLoops.map((openLoop) => openLoop.text).join("; ")}`
      )
    : say("Sorry, I could not look.");
};

const fakeDoneMessage = (ownerText: string, toolResult: string | undefined) => {
  const words = ownerText.slice(fakeDonePrefix.length);
  if (toolResult === undefined) {
    return toolCall("list_open_loops", {});
  }
  const listed = decodeListed(toolResult);
  if (Option.isSome(listed)) {
    const match = listed.value.openLoops.find((openLoop) =>
      openLoop.text.includes(words)
    );
    if (match !== undefined) {
      return toolCall("close_open_loop", {
        noteId: match.noteId,
        reason: "done",
      });
    }
    return listed.value.nextOffset === null
      ? say(`Nothing open matches: ${words}`)
      : toolCall("list_open_loops", { offset: listed.value.nextOffset });
  }
  const closed = decodeClosed(toolResult);
  return Option.isSome(closed)
    ? say(`Closed (${closed.value.openLoop.state}): ${closed.value.text}`)
    : say("Sorry, I could not close it.");
};

export const fakeOpenLoopMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  if (ownerText.startsWith(fakeTodoPrefix)) {
    return fakeTodoMessage(ownerText, toolResult);
  }
  if (ownerText.startsWith(fakeDonePrefix)) {
    return fakeDoneMessage(ownerText, toolResult);
  }
  return fakeWhatIsOpenMessage(toolResult);
};
