import { Data, Effect, Layer, Option, Schema } from "effect";

import { telegramChannel } from "../channels/telegram/telegram-channel.ts";
import {
  aiGatewayModelProvider,
  BillingModeSchema,
  ReasoningEffortSchema,
} from "../model-gateway/ai-gateway.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { OwnerId } from "../owner-id.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";

export class TurnConfigurationInvalid extends Data.TaggedError(
  "TurnConfigurationInvalid"
)<{ readonly names: readonly string[] }> {
  override get message() {
    return `The Worker configuration is missing or invalid for: ${this.names.join(", ")}`;
  }
}

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const HttpUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https?:\/\/\S+$/u))
);

const TurnEnvSchema = Schema.Struct({
  TELEGRAM_API_URL: HttpUrl,
  TELEGRAM_BOT_TOKEN: NonEmpty,
  AI_GATEWAY_URL: HttpUrl,
  AI_GATEWAY_ID: NonEmpty,
  AI_GATEWAY_TOKEN: NonEmpty,
  REPLY_MODEL: NonEmpty,
  REPLY_REASONING_EFFORT: ReasoningEffortSchema,
  MODEL_BILLING: BillingModeSchema,
});

const invalidNames = (env: Env) => {
  const values: Record<string, unknown> = { ...env };
  return Object.entries(TurnEnvSchema.fields)
    .filter(([name, schema]) =>
      Option.isNone(Schema.decodeUnknownOption(schema)(values[name]))
    )
    .map(([name]) => name);
};

export const decodeTurnEnv = (env: Env) =>
  Schema.decodeUnknownEffect(TurnEnvSchema)(env).pipe(
    Effect.mapError(
      () => new TurnConfigurationInvalid({ names: invalidNames(env) })
    )
  );

export const liveTurnServices = (env: Env, ownerId: OwnerId) =>
  Layer.unwrap(
    Effect.map(decodeTurnEnv(env), (config) =>
      Layer.mergeAll(
        OperatorMetrics.layer(env.OPERATOR_METRICS),
        Redactor.layer([
          config.TELEGRAM_BOT_TOKEN,
          config.AI_GATEWAY_TOKEN,
          env.TELEGRAM_WEBHOOK_SECRET,
          env.OPERATOR_TOKEN,
        ]),
        telegramChannel({
          apiUrl: config.TELEGRAM_API_URL,
          botToken: config.TELEGRAM_BOT_TOKEN,
        }),
        ModelGateway.layer.pipe(
          Layer.provide(
            aiGatewayModelProvider(
              {
                url: config.AI_GATEWAY_URL,
                gatewayId: config.AI_GATEWAY_ID,
                routes: {
                  reply: {
                    model: config.REPLY_MODEL,
                    reasoningEffort: config.REPLY_REASONING_EFFORT,
                  },
                },
              },
              {
                token: config.AI_GATEWAY_TOKEN,
                billing: config.MODEL_BILLING,
              },
              ownerId
            )
          )
        )
      )
    )
  );
