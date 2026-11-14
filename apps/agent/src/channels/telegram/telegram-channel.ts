import { Effect, Layer, Schema } from "effect";

import { Channel } from "../channel.ts";
import type { Delivery, OutgoingReply } from "../channel.ts";

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

const failed = (reason: string): Delivery => ({ _tag: "Failed", reason });

const sendMessageRequest = (config: TelegramConfig, reply: OutgoingReply) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(reply.conversationId),
      text: reply.text,
      reply_parameters: {
        message_id: Number(reply.inReplyTo),
        allow_sending_without_reply: true,
      },
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

const send = (config: TelegramConfig) => (reply: OutgoingReply) =>
  Effect.tryPromise(() =>
    (config.fetch ?? fetch)(sendMessageRequest(config, reply))
  ).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(failed("Telegram could not be reached")),
      onSuccess: deliveryFrom,
    })
  );

export const telegramChannel = (config: TelegramConfig) =>
  Layer.succeed(Channel, { send: send(config) });
