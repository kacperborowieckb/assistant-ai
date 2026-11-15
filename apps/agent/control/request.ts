import { Data, Effect, Option } from "effect";

import { startLocalFakes } from "./local-fakes.ts";
import type { FakeTelegramMessage } from "./local-fakes.ts";
import { startLocalWorker, temporarySecrets } from "./local-worker.ts";
import { addOwner, renderAddedOwner } from "./operator.ts";
import { sendTelegramUpdate } from "./telegram-update.ts";

const sampleTelegramUserId = 424_242;
const sampleMessageId = 7;
const replyTimeout = "30 seconds";
const nextPartTimeout = "1 second";

const collapseWhitespace = (text: string) => text.replaceAll(/\s+/gu, " ");

const replyPartsContain = (parts: readonly string[], contains: string) => {
  const wanted = collapseWhitespace(contains);
  return [" ", ""].some((separator) =>
    collapseWhitespace(parts.join(separator)).includes(wanted)
  );
};

export class ReplyMissing extends Data.TaggedError("ReplyMissing")<{
  readonly contains: string;
  readonly reply: string;
}> {
  override get message() {
    return `The reply does not contain "${this.contains}". Reply: "${this.reply}"`;
  }
}

export const requestReply = ({
  messages,
  contains,
}: {
  readonly messages: readonly string[];
  readonly contains: string;
}) =>
  Effect.gen(function* requestReplyEffect() {
    const fakes = yield* startLocalFakes();
    const secrets = temporarySecrets();
    const url = yield* startLocalWorker({
      vars: {
        TELEGRAM_API_URL: fakes.telegramApiUrl,
        AI_GATEWAY_URL: fakes.aiGatewayUrl,
      },
      secrets,
    });
    const lines: string[] = [
      `Local Worker: ${url.origin} (temporary storage, fake Telegram, fake model)`,
    ];

    const owner = yield* addOwner({
      workerUrl: url.origin,
      token: secrets.OPERATOR_TOKEN,
      telegramUserId: sampleTelegramUserId,
    });
    lines.push(renderAddedOwner(owner));

    let replyParts: readonly string[] = [];
    for (const [index, message] of messages.entries()) {
      const webhook = yield* sendTelegramUpdate({
        workerUrl: url,
        webhookSecret: secrets.TELEGRAM_WEBHOOK_SECRET,
        update: {
          updateId: index + 1,
          messageId: sampleMessageId + index + 1,
          userId: sampleTelegramUserId,
          text: message,
        },
      });
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
      replyParts = sentParts.map((part) => part.text);
      lines.push(
        `Telegram sendMessage to chat ${sent?.chatId ?? "none"}, reply to message ${sent?.replyToMessageId ?? "none"}: "${replyParts.join("")}"`
      );
    }
    for (const call of fakes.modelCalls()) {
      lines.push(
        `AI Gateway call: gateway ${call.gatewayId ?? "missing"}, metadata ${call.metadata ?? "missing"}, collect log payload ${call.collectLogPayload ?? "missing"}`
      );
    }
    if (!replyPartsContain(replyParts, contains)) {
      return yield* new ReplyMissing({ contains, reply: replyParts.join("") });
    }
    lines.push(`Result: the reply contains "${contains}"`);
    return lines.join("\n");
  }).pipe(Effect.scoped);
