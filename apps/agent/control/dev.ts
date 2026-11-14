import { Console, Effect } from "effect";

import { startLocalFakes } from "./local-fakes.ts";
import type { FakeTelegramMessage } from "./local-fakes.ts";
import { runWranglerAttached, runWranglerQuietly } from "./wrangler.ts";

const localState = [".wrangler/state"];

const renderSent = (message: FakeTelegramMessage) =>
  `Fake Telegram: sendMessage to chat ${message.chatId}, reply to message ${message.replyToMessageId ?? "none"}: "${message.text}"`;

export const runLocalWorker = Effect.gen(function* runLocalWorkerEffect() {
  const fakes = yield* startLocalFakes;
  yield* runWranglerQuietly([
    "d1",
    "migrations",
    "apply",
    "DIRECTORY",
    "--local",
    "--persist-to",
    ...localState,
  ]);
  yield* Console.log(
    `Fake Telegram API: ${fakes.telegramApiUrl}\nFake AI Gateway: ${fakes.aiGatewayUrl}`
  );
  yield* fakes.nextTelegramMessage.pipe(
    Effect.flatMap((message) => Console.log(renderSent(message))),
    Effect.forever,
    Effect.forkScoped
  );
  yield* runWranglerAttached([
    "dev",
    "--local",
    "--persist-to",
    ...localState,
    "--var",
    `TELEGRAM_API_URL:${fakes.telegramApiUrl}`,
    "--var",
    `AI_GATEWAY_URL:${fakes.aiGatewayUrl}`,
  ]);
}).pipe(Effect.scoped);
