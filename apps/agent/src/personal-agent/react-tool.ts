import { Option, Schema } from "effect";

import { effectInputSchema, outcomeTool } from "../model-gateway/agent-tool.ts";
import type { PendingToolCall } from "../model-gateway/model-step.ts";
import type { ReactionOutcome } from "./turn-record.ts";

export const reactToolName = "react";

export const reactionAfterFailureMessage =
  "Reaction refused: a tool call that changes Owner data failed in this Turn. Answer the Owner with a text that says what did not work.";

export const reactionAcceptedOutput = (emoji: string) =>
  ({ outcome: "reaction", emoji }) as const;

const ReactInputSchema = Schema.Struct({ emoji: Schema.String });

export const reactTool = outcomeTool({
  description:
    'End the Turn with one emoji reaction on the newest message of the Owner, and send no text. Use it when nothing needs to be said, such as after you saved what the Owner sent. Pick any emoji that fits, with some personality: "buy milk" can get ✍, "done with the report" can get 🔥. Never use it when something failed or when the Owner asked a question. Code refuses it after a failed change, and then you answer with text.',
  inputSchema: effectInputSchema(ReactInputSchema),
});

export const reactSection = `When the Owner sent something that needs no words back, such as a thing to keep or news that a task is done, you may call ${reactToolName} with one emoji instead of writing a reply, and write nothing else. Choose the emoji freely, and jokes are welcome. A reaction means that what the Owner asked for really happened. When something failed or the Owner asked a question, answer with text.`;

const decodeReactInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReactInputSchema)
);

export const requestedEmojiOf = (calls: readonly PendingToolCall[]) => {
  const call = calls.find((pending) => pending.name === reactToolName);
  if (call === undefined) {
    return;
  }
  return decodeReactInput(call.input).pipe(
    Option.map((input) => input.emoji),
    Option.getOrElse(() => "")
  );
};

export const reactionFor = (
  requested: string,
  allowedReaction: (emoji: string) => string | undefined,
  defaultReaction: string
): ReactionOutcome => {
  const emoji = allowedReaction(requested) ?? defaultReaction;
  return emoji === requested ? { emoji } : { emoji, requestedEmoji: requested };
};
