import { Schema } from "effect";

export const fakeReactionPrefix = "react:";

export const isFakeReaction = (ownerText: string) =>
  ownerText.trim().toLowerCase().startsWith(fakeReactionPrefix);

export const fakeReactionMessage = (
  ownerText: string,
  toolResult: string | undefined
) =>
  toolResult === undefined
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-react-1",
            type: "function",
            function: {
              name: "react",
              arguments: JSON.stringify({
                emoji: ownerText.trim().slice(fakeReactionPrefix.length).trim(),
              }),
            },
          },
        ],
      }
    : { role: "assistant", content: "Okay." };

export interface FakeTelegramReaction {
  readonly chatId: number;
  readonly messageId: number;
  readonly emoji: string;
}

const SetMessageReactionBodySchema = Schema.Struct({
  chat_id: Schema.Number,
  message_id: Schema.Number,
  reaction: Schema.Array(Schema.Struct({ emoji: Schema.String })),
});

const setMessageReactionPath = /^\/telegram\/bot[^/]+\/setMessageReaction$/u;

export const isSetMessageReaction = (url: string | undefined) =>
  setMessageReactionPath.test(url ?? "");

export const fakeReactions = () => {
  const recorded: FakeTelegramReaction[] = [];
  return {
    record: (body: unknown) => {
      const reaction = Schema.decodeUnknownSync(SetMessageReactionBodySchema)(
        body
      );
      recorded.push({
        chatId: reaction.chat_id,
        messageId: reaction.message_id,
        emoji: reaction.reaction.map((each) => each.emoji).join(""),
      });
      return { ok: true, result: true };
    },
    list: (): readonly FakeTelegramReaction[] => [...recorded],
  };
};
