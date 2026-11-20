import { Effect, Layer, Schema } from "effect";

import { Channel } from "../channel.ts";
import type { Delivery, OutgoingMessage } from "../channel.ts";
import { TypingNotShown } from "../typing-not-shown.ts";

export interface TelegramConfig {
  readonly apiUrl: string;
  readonly botToken: string;
  readonly fetch?: typeof fetch;
}

const SendMessageResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({ message_id: Schema.Int }),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    description: Schema.optionalKey(Schema.String),
  }),
]);

const ChatActionResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    description: Schema.optionalKey(Schema.String),
  }),
]);

const failed = (reason: string): Delivery => ({ _tag: "Failed", reason });

export const telegramTextLimit = 4096;

const cutPosition = (text: string) => {
  const window = text.slice(0, telegramTextLimit);
  const lastBreak = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  const cut = lastBreak > 0 ? lastBreak : telegramTextLimit;
  const splitsSurrogatePair = /[\uD800-\uDBFF]/u.test(text.charAt(cut - 1));
  return splitsSurrogatePair ? cut - 1 : cut;
};

const splitAtLimit = (text: string): readonly string[] => {
  if (text.length <= telegramTextLimit) {
    return [text];
  }
  const cut = cutPosition(text);
  return [
    text.slice(0, cut).trimEnd(),
    ...splitAtLimit(text.slice(cut).trimStart()),
  ];
};

const hasText = (part: string) => part.trim().length > 0;

export const telegramParts = (text: string): readonly string[] =>
  splitAtLimit(text).filter(hasText);

const sendMessageRequest = (config: TelegramConfig, message: OutgoingMessage) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(message.conversationId),
      text: message.text,
      ...(message.inReplyTo === undefined
        ? {}
        : {
            reply_parameters: {
              message_id: Number(message.inReplyTo),
              allow_sending_without_reply: true,
            },
          }),
    }),
  });

const deliveryFrom = (response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SendMessageResponseSchema)),
    Effect.map((answer): Delivery => {
      if (answer.ok) {
        return {
          _tag: "Confirmed",
          channelMessageId: String(answer.result.message_id),
        };
      }
      return failed(
        `Telegram refused the message (${response.status}): ${answer.description ?? "no description"}`
      );
    }),
    Effect.orElseSucceed(() =>
      failed(`Telegram answered ${response.status} without a result`)
    )
  );

const sendPart = (config: TelegramConfig, message: OutgoingMessage) =>
  Effect.tryPromise(() =>
    (config.fetch ?? fetch)(sendMessageRequest(config, message))
  ).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(failed("Telegram could not be reached")),
      onSuccess: deliveryFrom,
    })
  );

const send = (config: TelegramConfig) => (message: OutgoingMessage) =>
  Effect.gen(function* sendEffect() {
    const parts = telegramParts(message.text);
    const [first, ...rest] = parts;
    if (first === undefined) {
      return failed("The reply has no text");
    }
    let delivery = yield* sendPart(config, { ...message, text: first });
    let sentParts = 1;
    for (const text of rest) {
      if (delivery._tag === "Failed") {
        break;
      }
      delivery = yield* sendPart(config, { ...message, text });
      sentParts += 1;
    }
    if (delivery._tag === "Failed" && parts.length > 1) {
      return failed(`Part ${sentParts} of ${parts.length}: ${delivery.reason}`);
    }
    return delivery;
  });

const sendChatActionRequest = (
  config: TelegramConfig,
  conversationId: string
) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(conversationId), action: "typing" }),
  });

const notShown = (reason: string) => new TypingNotShown({ reason });

const typingAnswerOf = (response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ChatActionResponseSchema)),
    Effect.mapError(() =>
      notShown(`Telegram answered ${response.status} without a result`)
    ),
    Effect.flatMap((answer) =>
      answer.ok
        ? Effect.void
        : Effect.fail(
            notShown(
              `Telegram refused the chat action (${response.status}): ${answer.description ?? "no description"}`
            )
          )
    )
  );

const showTyping = (config: TelegramConfig) => (conversationId: string) =>
  Effect.tryPromise({
    try: (signal) =>
      (config.fetch ?? fetch)(
        new Request(sendChatActionRequest(config, conversationId), { signal })
      ),
    catch: () => notShown("Telegram could not be reached"),
  }).pipe(Effect.flatMap(typingAnswerOf));

export const telegramChannel = (config: TelegramConfig) =>
  Layer.succeed(Channel, {
    send: send(config),
    showTyping: showTyping(config),
  });
