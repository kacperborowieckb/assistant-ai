import { Schema } from "effect";

export interface FakeTelegramChatAction {
  readonly chatId: number;
  readonly action: string;
}

const SendChatActionBodySchema = Schema.Struct({
  chat_id: Schema.Number,
  action: Schema.String,
});

const sendChatActionPath = /^\/telegram\/bot[^/]+\/sendChatAction$/u;

export const isSendChatAction = (url: string | undefined) =>
  sendChatActionPath.test(url ?? "");

export const fakeChatActions = () => {
  const recorded: FakeTelegramChatAction[] = [];
  return {
    record: (body: unknown) => {
      const chatAction = Schema.decodeUnknownSync(SendChatActionBodySchema)(
        body
      );
      recorded.push({ chatId: chatAction.chat_id, action: chatAction.action });
      return { ok: true, result: true };
    },
    list: (): readonly FakeTelegramChatAction[] => [...recorded],
  };
};
