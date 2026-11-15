import { Option, Schema } from "effect";

import type { OwnerMessage } from "../../event.ts";

const ForwardOriginSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    sender_user: Schema.Struct({
      first_name: Schema.String,
      last_name: Schema.optionalKey(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("hidden_user"),
    sender_user_name: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("chat"),
    sender_chat: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
  }),
  Schema.Struct({
    type: Schema.Literal("channel"),
    chat: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
  }),
  Schema.Struct({ type: Schema.String }),
]);

type ForwardOrigin = typeof ForwardOriginSchema.Type;

const unknownForwardOrigin = "an unknown sender";

const forwardOriginName = (origin: ForwardOrigin): string => {
  if ("sender_user" in origin) {
    return [origin.sender_user.first_name, origin.sender_user.last_name]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
  }
  if ("sender_user_name" in origin) {
    return origin.sender_user_name;
  }
  if ("sender_chat" in origin) {
    return origin.sender_chat.title ?? unknownForwardOrigin;
  }
  if ("chat" in origin) {
    return origin.chat.title ?? unknownForwardOrigin;
  }
  return unknownForwardOrigin;
};

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
      forward_origin: Schema.optionalKey(ForwardOriginSchema),
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
          ...(message.forward_origin === undefined
            ? {}
            : { forwardOrigin: forwardOriginName(message.forward_origin) }),
        },
      });
    })
  );
