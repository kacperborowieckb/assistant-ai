import { DateTime, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const millisecondsPerSecond = 1000;

export interface TelegramTextUpdate {
  readonly updateId: number;
  readonly messageId: number;
  readonly userId: number;
  readonly text: string;
  readonly forwardedFrom?: string | undefined;
}

const telegramUpdateBody = (
  { updateId, messageId, userId, text, forwardedFrom }: TelegramTextUpdate,
  sentAt: DateTime.Utc
) => ({
  update_id: updateId,
  message: {
    message_id: messageId,
    date: Math.floor(DateTime.toEpochMillis(sentAt) / millisecondsPerSecond),
    chat: { id: userId, type: "private" },
    from: { id: userId, is_bot: false, first_name: "Owner" },
    text,
    ...(forwardedFrom === undefined
      ? {}
      : {
          forward_origin: {
            type: "user",
            sender_user: { first_name: forwardedFrom },
          },
        }),
  },
});

export const sendTelegramUpdate = Effect.fnUntraced(
  function* sendTelegramUpdate({
    workerUrl,
    webhookSecret,
    update,
  }: {
    readonly workerUrl: URL;
    readonly webhookSecret: string;
    readonly update: TelegramTextUpdate;
  }) {
    const client = yield* HttpClient.HttpClient;
    const sentAt = yield* DateTime.now;
    const response = yield* client.execute(
      HttpClientRequest.post(new URL("/telegram/webhook", workerUrl)).pipe(
        HttpClientRequest.setHeader(
          "X-Telegram-Bot-Api-Secret-Token",
          webhookSecret
        ),
        HttpClientRequest.bodyJsonUnsafe(telegramUpdateBody(update, sentAt))
      )
    );
    return { status: response.status, text: yield* response.text };
  },
  Effect.provide(FetchHttpClient.layer)
);
