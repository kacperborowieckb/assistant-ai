import { randomUUID } from "node:crypto";

import { Data, Effect } from "effect";
import { createTestHarness } from "wrangler";

import { startLocalFakes } from "./local-fakes.ts";
import { addOwner, renderAddedOwner } from "./operator.ts";
import { agentRoot, wranglerConfigPath } from "./workspace.ts";

const sampleTelegramUserId = 424_242;
const sampleMessageId = 7;
const replyTimeout = "30 seconds";

export class ReplyMissing extends Data.TaggedError("ReplyMissing")<{
  readonly contains: string;
  readonly reply: string;
}> {
  override get message() {
    return `The reply does not contain "${this.contains}". Reply: "${this.reply}"`;
  }
}

const sampleUpdate = (text: string) => ({
  update_id: 1,
  message: {
    message_id: sampleMessageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: sampleTelegramUserId, type: "private" },
    from: { id: sampleTelegramUserId, is_bot: false, first_name: "Owner" },
    text,
  },
});

const startLocalWorker = (
  vars: Record<string, string>,
  secrets: Record<string, string>
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const harness = createTestHarness({
        root: agentRoot,
        workers: [{ configPath: wranglerConfigPath, vars, secrets }],
      });
      const { url } = await harness.listen();
      await harness.getWorker().applyD1Migrations("DIRECTORY");
      return { harness, url };
    }),
    ({ harness }) => Effect.promise(() => harness.close())
  );

export const requestReply = ({
  message,
  contains,
}: {
  readonly message: string;
  readonly contains: string;
}) =>
  Effect.gen(function* requestReplyEffect() {
    const fakes = yield* startLocalFakes;
    const secrets = {
      TELEGRAM_BOT_TOKEN: `local-${randomUUID()}`,
      TELEGRAM_WEBHOOK_SECRET: randomUUID(),
      AI_GATEWAY_TOKEN: `local-${randomUUID()}`,
      OPERATOR_TOKEN: randomUUID(),
    };
    const { url } = yield* startLocalWorker(
      {
        TELEGRAM_API_URL: fakes.telegramApiUrl,
        AI_GATEWAY_URL: fakes.aiGatewayUrl,
      },
      secrets
    );
    const lines: string[] = [
      `Local Worker: ${url.origin} (temporary storage, fake Telegram, fake model)`,
    ];

    const owner = yield* addOwner({
      workerUrl: url.origin,
      token: secrets.OPERATOR_TOKEN,
      telegramUserId: sampleTelegramUserId,
    });
    lines.push(renderAddedOwner(owner));

    const webhook = yield* Effect.promise(() =>
      fetch(new URL("/telegram/webhook", url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": secrets.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify(sampleUpdate(message)),
      })
    );
    lines.push(
      `Webhook answered ${webhook.status} for the message "${message}"`
    );

    const sent = yield* fakes.nextTelegramMessage.pipe(
      Effect.timeout(replyTimeout)
    );
    lines.push(
      `Telegram sendMessage to chat ${sent.chatId}, reply to message ${sent.replyToMessageId ?? "none"}: "${sent.text}"`
    );
    for (const call of fakes.modelCalls()) {
      lines.push(
        `AI Gateway call: gateway ${call.gatewayId ?? "missing"}, metadata ${call.metadata ?? "missing"}, collect log payload ${call.collectLogPayload ?? "missing"}`
      );
    }
    if (!sent.text.includes(contains)) {
      return yield* new ReplyMissing({ contains, reply: sent.text });
    }
    lines.push(`Result: the reply contains "${contains}"`);
    return lines.join("\n");
  }).pipe(Effect.scoped);
