import { Data, Effect, Option } from "effect";

import { startLocalFakes } from "./local-fakes.ts";
import type { FakeModelCall, FakeTelegramMessage } from "./local-fakes.ts";
import { startLocalWorker, temporarySecrets } from "./local-worker.ts";
import { addOwner, renderAddedOwner } from "./operator.ts";
import { selectReplyTo } from "./reply-selection.ts";
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
  readonly contains: string | undefined;
  readonly reply: string;
}> {
  override get message() {
    return this.contains === undefined
      ? `The agent sent no reply. Reply: "${this.reply}"`
      : `The reply does not contain "${this.contains}". Reply: "${this.reply}"`;
  }
}

// The control project cannot import the Worker module that defines the name.
const staySilentToolName = "stay_silent";

const stayedSilentOn = (
  modelCalls: readonly FakeModelCall[],
  message: string
) =>
  modelCalls
    .findLast((call) => call.lastUserMessage === message)
    ?.toolCalls.includes(staySilentToolName) === true;

export const requestReply = ({
  messages,
  contains,
  waitForLaterMessage,
}: {
  readonly messages: readonly string[];
  readonly contains: string | undefined;
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
    const unprompted: FakeTelegramMessage[] = [];
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
      const selection = yield* selectReplyTo({
        inputMessageId: sampleMessageId + index + 1,
        take: (timeout) =>
          fakes.nextTelegramMessage.pipe(Effect.timeoutOption(timeout)),
        firstReplyTimeout: replyTimeout,
        nextPartTimeout,
        stayedSilent: Effect.sync(() =>
          stayedSilentOn(fakes.modelCalls(), message)
        ),
      });
      unprompted.push(...selection.unprompted);
      const [sent] = selection.replyParts;
      if (sent === undefined) {
        if (!stayedSilentOn(fakes.modelCalls(), message)) {
          return yield* new ReplyMissing({ contains, reply: "" });
        }
        replyParts = [];
        lines.push(
          `No Telegram send for the message "${message}": the agent stayed silent (${staySilentToolName})`
        );
        continue;
      }
      replyParts = selection.replyParts.map((part) => part.text);
      lines.push(
        `Telegram sendMessage to chat ${sent.chatId}, reply to message ${sent.replyToMessageId ?? "none"}: "${replyParts.join("")}"`
      );
    }
    if (contains === undefined) {
      for (const call of fakes.modelCalls()) {
        lines.push(
          `AI Gateway call: gateway ${call.gatewayId ?? "missing"}, metadata ${call.metadata ?? "missing"}, collect log payload ${call.collectLogPayload ?? "missing"}`
        );
      }
      lines.push(
        `Telegram sendMessage calls in total: ${fakes.sentTelegramMessages().length}`
      );
      return lines.join("\n");
    }
    let waiting =
      waitForLaterMessage && !replyPartsContain(replyParts, contains);
    while (waiting) {
      const queued = Option.fromNullishOr(unprompted.shift());
      const later = Option.isSome(queued)
        ? queued
        : yield* fakes.nextTelegramMessage.pipe(
            Effect.timeoutOption(laterMessageTimeout)
          );
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
