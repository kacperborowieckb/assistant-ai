import { createExecutionContext, env } from "cloudflare:test";

import worker from "../src/index.ts";
import { fakeMetrics } from "./fakes.ts";

let nextUpdateId = 1000;

export const textUpdate = ({
  fromUserId,
  text,
  messageId = 77,
  forwardOrigin,
}: {
  readonly fromUserId: number;
  readonly text: string;
  readonly messageId?: number;
  readonly forwardOrigin?: object;
}) => {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: messageId,
      date: 1_794_000_000,
      chat: { id: fromUserId, type: "private" },
      from: { id: fromUserId, is_bot: false, first_name: "Owner" },
      text,
      ...(forwardOrigin === undefined ? {} : { forward_origin: forwardOrigin }),
    },
  };
};

export const sendToEdge = (request: Parameters<typeof worker.fetch>[0]) =>
  worker.fetch(
    request,
    { ...env, OPERATOR_METRICS: fakeMetrics.dataset },
    createExecutionContext()
  );

export const telegramWebhook = (
  update: unknown,
  secret: string | null = env.TELEGRAM_WEBHOOK_SECRET
) =>
  sendToEdge(
    new Request("https://agent.test/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret === null
          ? {}
          : { "X-Telegram-Bot-Api-Secret-Token": secret }),
      },
      body: JSON.stringify(update),
    })
  );

export const addOwnerRequest = (
  telegramUserId: number,
  token: string | null = env.OPERATOR_TOKEN
) =>
  sendToEdge(
    new Request("https://agent.test/operator/owners", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ telegramUserId }),
    })
  );

export const addOwner = async (telegramUserId: number) => {
  const response = await addOwnerRequest(telegramUserId);
  const body = await response.json<{ ownerId: string }>();
  return body.ownerId;
};
