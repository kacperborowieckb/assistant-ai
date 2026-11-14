import { Option, Schema } from "effect";

import type { OwnerMessage } from "../../event.ts";

const TelegramUpdateSchema = Schema.Struct({
  update_id: Schema.Int,
  message: Schema.optionalKey(
    Schema.Struct({
      message_id: Schema.Int,
      date: Schema.Int,
      chat: Schema.Struct({ id: Schema.Int, type: Schema.String }),
      from: Schema.optionalKey(
        Schema.Struct({ id: Schema.Int, is_bot: Schema.Boolean })
      ),
      text: Schema.optionalKey(Schema.String),
    })
  ),
});

export interface TelegramTextMessage {
  readonly senderId: number;
  readonly message: OwnerMessage;
}

const millisecondsPerSecond = 1000;

export const textMessageFrom = (
  body: unknown
): Option.Option<TelegramTextMessage> =>
  Schema.decodeUnknownOption(TelegramUpdateSchema)(body).pipe(
    Option.flatMap(({ update_id: updateId, message }) => {
      if (
        message?.text === undefined ||
        message.from === undefined ||
        message.from.is_bot ||
        message.chat.type !== "private"
      ) {
        return Option.none();
      }
      return Option.some({
        senderId: message.from.id,
        message: {
          channel: "telegram",
          channelUpdateId: String(updateId),
          conversationId: String(message.chat.id),
          channelMessageId: String(message.message_id),
          text: message.text,
          sentAt: new Date(message.date * millisecondsPerSecond).toISOString(),
        },
      });
    })
  );
