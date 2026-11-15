import { Effect, Schedule, Schema } from "effect";

import {
  AgentObservationSchema,
  evalRoutes,
  JudgeResultSchema,
  SeedResponseSchema,
} from "../../eval/eval-contract.ts";
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
import { EvalWorkerFailed } from "./eval-worker-failed.ts";
import { TurnUnfinished } from "./turn-unfinished.ts";

export const evalWorkerMain = "eval/worker.ts";

const observationInterval = "250 millis";
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

    const postEval = <Response>(
      route: string,
      body: unknown,
      schema: Schema.Codec<Response, unknown>
    ) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(new URL(route, workerUrl), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${secrets.OPERATOR_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
          return { status: response.status, text: await response.text() };
        },
        catch: (cause) =>
          new EvalWorkerFailed({ route, detail: String(cause) }),
      }).pipe(
        Effect.flatMap(({ status, text }) =>
          status === 200
            ? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
                text
              ).pipe(
                Effect.mapError(
                  ({ message }) =>
                    new EvalWorkerFailed({ route, detail: message })
                )
              )
            : Effect.fail(
                new EvalWorkerFailed({ route, detail: `${status} ${text}` })
              )
        )
      );

    const observe = (ownerId: string) =>
      postEval(evalRoutes.observation, { ownerId }, AgentObservationSchema);

    const settled = (ownerId: string, ownerText: string) =>
      observe(ownerId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(observationInterval),
          until: (observation) => observation.pendingEventCount === 0,
        }),
        Effect.timeoutOrElse({
          duration: turnTimeoutMillis,
          orElse: () =>
            Effect.fail(
              new TurnUnfinished({
                ownerText,
                timeoutMillis: turnTimeoutMillis,
              })
            ),
        })
      );

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
      });
      if (webhook.status !== 200) {
        return yield* new EvalWorkerFailed({
          route: "/telegram/webhook",
          detail: `${webhook.status} ${yield* Effect.promise(() => webhook.text())}`,
        });
      }
      yield* settled(ownerId, event.text);
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
        yield* postEval(
          evalRoutes.seed,
          {
            ownerId,
            conversationId: String(userId),
            notes: evalCase.seed.notes ?? [],
            profile: evalCase.seed.profile ?? [],
          },
          SeedResponseSchema
        );
      }
      const exchanges: Exchange[] = [];
      for (const event of evalCase.events) {
        exchanges.push(yield* exchange(ownerId, userId, event));
      }
      return {
        ownerId,
        exchanges,
        observation: yield* observe(ownerId),
      } satisfies EvalRun;
    });

    const judge = (
      run: EvalRun,
      rubric: string
    ): Effect.Effect<JudgeResult, EvalWorkerFailed> =>
      postEval(
        evalRoutes.judge,
        { ownerId: run.ownerId, rubric, exchanges: run.exchanges },
        JudgeResultSchema
      );

    return { runCase, judge };
  }
);
