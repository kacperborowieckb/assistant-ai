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
const laterMessageTimeout = "100 seconds";

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
  waitForLaterMessage,
}: {
  readonly messages: readonly string[];
  readonly contains: string;
  readonly waitForLaterMessage: boolean;
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
    let carried: FakeTelegramMessage | undefined;
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
      const first =
        carried ??
        (yield* fakes.nextTelegramMessage.pipe(Effect.timeout(replyTimeout)));
      carried = undefined;
      const sentParts: FakeTelegramMessage[] = [first];
      for (;;) {
        const nextPart = yield* fakes.nextTelegramMessage.pipe(
          Effect.timeoutOption(nextPartTimeout)
        );
        if (Option.isNone(nextPart)) {
          break;
        }
        if (
          nextPart.value.replyToMessageId !== sentParts[0]?.replyToMessageId
        ) {
          carried = nextPart.value;
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
    let waiting =
      waitForLaterMessage && !replyPartsContain(replyParts, contains);
    while (waiting) {
      const later = carried
        ? Option.some(carried)
        : yield* fakes.nextTelegramMessage.pipe(
            Effect.timeoutOption(laterMessageTimeout)
          );
      carried = undefined;
      if (Option.isNone(later)) {
        waiting = false;
      } else {
        replyParts = [later.value.text];
        lines.push(
          `Telegram sendMessage to chat ${later.value.chatId}, no message to reply to: "${later.value.text}"`
        );
        waiting = !replyPartsContain(replyParts, contains);
      }
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
