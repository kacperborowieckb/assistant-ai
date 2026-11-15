import { randomUUID } from "node:crypto";

import { Data, Effect, Option } from "effect";
import { createTestHarness } from "wrangler";

import { startLocalFakes } from "./local-fakes.ts";
import type { FakeTelegramMessage } from "./local-fakes.ts";
import { addOwner, renderAddedOwner } from "./operator.ts";
import { agentRoot, wranglerConfigPath } from "./workspace.ts";

const sampleTelegramUserId = 424_242;
const sampleMessageId = 7;
const replyTimeout = "30 seconds";
const nextPartTimeout = "1 second";
const partJoiner = "\n";

const collapseWhitespace = (text: string) => text.replaceAll(/\s+/gu, " ");

const replyContains = (reply: string, contains: string) =>
  collapseWhitespace(reply).includes(collapseWhitespace(contains)) ||
  collapseWhitespace(reply.replaceAll(partJoiner, "")).includes(
    collapseWhitespace(contains)
  );

export class ReplyMissing extends Data.TaggedError("ReplyMissing")<{
  readonly contains: string;
  readonly reply: string;
}> {
  override get message() {
    return `The reply does not contain "${this.contains}". Reply: "${this.reply}"`;
  }
}

const sampleUpdate = (text: string, position: number) => ({
  update_id: position,
  message: {
    message_id: sampleMessageId + position,
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
  messages,
  contains,
}: {
  readonly messages: readonly string[];
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

    let reply = "";
    for (const [index, message] of messages.entries()) {
      const webhook = yield* Effect.promise(() =>
        fetch(new URL("/telegram/webhook", url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": secrets.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify(sampleUpdate(message, index + 1)),
        })
      );
      lines.push(
        `Webhook answered ${webhook.status} for the message "${message}"`
      );
      const sentParts: FakeTelegramMessage[] = [
        yield* fakes.nextTelegramMessage.pipe(Effect.timeout(replyTimeout)),
      ];
      for (;;) {
        const nextPart = yield* fakes.nextTelegramMessage.pipe(
          Effect.timeoutOption(nextPartTimeout)
        );
        if (
          Option.isNone(nextPart) ||
          nextPart.value.replyToMessageId !== sentParts[0]?.replyToMessageId
        ) {
          break;
        }
        sentParts.push(nextPart.value);
      }
      const [sent] = sentParts;
      reply = sentParts.map((part) => part.text).join(partJoiner);
      lines.push(
        `Telegram sendMessage to chat ${sent?.chatId ?? "none"}, reply to message ${sent?.replyToMessageId ?? "none"}: "${reply}"`
      );
    }
    for (const call of fakes.modelCalls()) {
      lines.push(
        `AI Gateway call: gateway ${call.gatewayId ?? "missing"}, metadata ${call.metadata ?? "missing"}, collect log payload ${call.collectLogPayload ?? "missing"}`
      );
    }
    if (!replyContains(reply, contains)) {
      return yield* new ReplyMissing({ contains, reply });
    }
    lines.push(`Result: the reply contains "${contains}"`);
    return lines.join("\n");
  }).pipe(Effect.scoped);
