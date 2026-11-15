import { Effect } from "effect";

export interface TelegramTextUpdate {
  readonly updateId: number;
  readonly messageId: number;
  readonly userId: number;
  readonly text: string;
  readonly forwardedFrom?: string | undefined;
}

const telegramUpdateBody = ({
  updateId,
  messageId,
  userId,
  text,
  forwardedFrom,
}: TelegramTextUpdate) => ({
  update_id: updateId,
  message: {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
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

export const sendTelegramUpdate = ({
  workerUrl,
  webhookSecret,
  update,
}: {
  readonly workerUrl: URL;
  readonly webhookSecret: string;
  readonly update: TelegramTextUpdate;
}) =>
  Effect.promise(() =>
    fetch(new URL("/telegram/webhook", workerUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
      },
      body: JSON.stringify(telegramUpdateBody(update)),
    })
  );
