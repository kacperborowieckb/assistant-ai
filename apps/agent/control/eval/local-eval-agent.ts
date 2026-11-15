import { Effect } from "effect";

import type {
  AgentObservation,
  Exchange,
  JudgeResult,
} from "../../eval/eval-contract.ts";
import { defaultBehaviorConfig } from "../../src/behavior/behavior-config.ts";
import {
  attemptTimeoutMillis,
  modelAttempts,
} from "../../src/model-gateway/model-call-policy.ts";
import type { FakeTelegramMessage } from "../local-fakes.ts";
import { startLocalWorker, temporarySecrets } from "../local-worker.ts";
import { addOwner } from "../operator.ts";
import { sendTelegramUpdate } from "../telegram-update.ts";
import type { EvalCase, OwnerEvent } from "./eval-case.ts";
import { evalWorkerClient } from "./eval-worker-client.ts";
import { EvalWorkerFailed } from "./eval-worker-failed.ts";

export const evalWorkerMain = "eval/worker.ts";

const turnMarginMillis = 30_000;
export const turnTimeoutMillis =
  defaultBehaviorConfig.maxToolSteps * modelAttempts * attemptTimeoutMillis +
  turnMarginMillis;

export interface ModelAccess {
  readonly aiGatewayUrl: string;
  readonly aiGatewayToken: string;
  readonly vars?: Readonly<Record<string, string>>;
}

export interface FakeTelegramApi {
  readonly telegramApiUrl: string;
  readonly sentTelegramMessages: () => readonly FakeTelegramMessage[];
}

export interface EvalRun {
  readonly ownerId: string;
  readonly exchanges: readonly Exchange[];
  readonly observation: AgentObservation;
}

const firstTelegramUserId = 1001;
const firstMessageId = 1;

const replyTo = (
  sent: readonly FakeTelegramMessage[],
  userId: number,
  messageId: number
) => {
  const parts = sent.filter(
    (message) =>
      message.chatId === userId && message.replyToMessageId === messageId
  );
  return parts.length === 0 ? null : parts.map((part) => part.text).join("\n");
};

export const startLocalEvalAgent = Effect.fnUntraced(
  function* startLocalEvalAgent({
    telegram,
    model,
  }: {
    readonly telegram: FakeTelegramApi;
    readonly model: ModelAccess;
  }) {
    const secrets = {
      ...temporarySecrets(),
      AI_GATEWAY_TOKEN: model.aiGatewayToken,
    };
    const workerUrl = yield* startLocalWorker({
      main: evalWorkerMain,
      vars: {
        ...model.vars,
        TELEGRAM_API_URL: telegram.telegramApiUrl,
        AI_GATEWAY_URL: model.aiGatewayUrl,
      },
      secrets,
    });
    let nextTelegramUserId = firstTelegramUserId;
    let nextMessageId = firstMessageId;

    const client = evalWorkerClient({
      workerUrl,
      operatorToken: secrets.OPERATOR_TOKEN,
      turnTimeoutMillis,
    });

    const exchange = Effect.fnUntraced(function* exchange(
      ownerId: string,
      userId: number,
      event: OwnerEvent
    ) {
      const messageId = nextMessageId;
      nextMessageId += 1;
      const webhook = yield* sendTelegramUpdate({
        workerUrl,
        webhookSecret: secrets.TELEGRAM_WEBHOOK_SECRET,
        update: {
          updateId: messageId,
          messageId,
          userId,
          text: event.text,
          forwardedFrom: event.forwardedFrom,
        },
      }).pipe(
        Effect.mapError(
          ({ message }) =>
            new EvalWorkerFailed({
              route: "/telegram/webhook",
              detail: message,
            })
        )
      );
      if (webhook.status !== 200) {
        return yield* new EvalWorkerFailed({
          route: "/telegram/webhook",
          detail: `${webhook.status} ${webhook.text}`,
        });
      }
      yield* client.settled(ownerId, event.text);
      return {
        ownerText: event.text,
        ...(event.forwardedFrom === undefined
          ? {}
          : { forwardedFrom: event.forwardedFrom }),
        agentReply: replyTo(telegram.sentTelegramMessages(), userId, messageId),
      } satisfies Exchange;
    });

    const runCase = Effect.fnUntraced(function* runCase(evalCase: EvalCase) {
      const userId = nextTelegramUserId;
      nextTelegramUserId += 1;
      const { ownerId } = yield* addOwner({
        workerUrl: workerUrl.origin,
        token: secrets.OPERATOR_TOKEN,
        telegramUserId: userId,
      });
      if (evalCase.seed !== undefined) {
        yield* client.seed({
          ownerId,
          conversationId: String(userId),
          notes: evalCase.seed.notes ?? [],
          profile: evalCase.seed.profile ?? [],
        });
      }
      const exchanges: Exchange[] = [];
      for (const event of evalCase.events) {
        exchanges.push(yield* exchange(ownerId, userId, event));
      }
      return {
        ownerId,
        exchanges,
        observation: yield* client.observe(ownerId),
      } satisfies EvalRun;
    });

    const judge = (
      run: EvalRun,
      rubric: string
    ): Effect.Effect<JudgeResult, EvalWorkerFailed> =>
      client.judge({ ownerId: run.ownerId, rubric, exchanges: run.exchanges });

    return { runCase, judge };
  }
);
