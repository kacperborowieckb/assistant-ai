import { Data, Effect, Layer, Option, Schema } from "effect";

import { telegramChannel } from "../channels/telegram/telegram-channel.ts";
import {
  aiGatewayModelProvider,
  BillingModeSchema,
} from "../model-gateway/ai-gateway.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { OwnerId } from "../owner-id.ts";

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
      Layer.merge(
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
                models: { reply: config.REPLY_MODEL },
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
