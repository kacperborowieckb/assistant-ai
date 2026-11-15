import { env } from "cloudflare:workers";
import { Layer } from "effect";

import { telegramChannel } from "../src/channels/telegram/telegram-channel.ts";
import { ModelGateway } from "../src/model-gateway/model-gateway.ts";
import { ModelProvider } from "../src/model-gateway/model-provider.ts";
import { PersonalAgent as LivePersonalAgent } from "../src/personal-agent/personal-agent.ts";
import type { TurnServices } from "../src/personal-agent/personal-agent.ts";
import { OperatorMetrics } from "../src/tracing/operator-metrics.ts";
import { Redactor } from "../src/tracing/redactor.ts";
import {
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  fakeTelegramApiUrl,
} from "./fakes.ts";

export { default } from "../src/index.ts";

const fakeTurnServices: TurnServices = Layer.mergeAll(
  OperatorMetrics.layer(fakeMetrics.dataset),
  Redactor.layer([
    env.TELEGRAM_BOT_TOKEN,
    env.AI_GATEWAY_TOKEN,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.OPERATOR_TOKEN,
  ]),
  telegramChannel({
    apiUrl: fakeTelegramApiUrl,
    botToken: env.TELEGRAM_BOT_TOKEN,
    fetch: fakeTelegram.fetch,
  }),
  ModelGateway.layer.pipe(
    Layer.provide(
      Layer.succeed(ModelProvider, {
        route: () => ({ model: fakeModel, reasoningEffort: "none" }),
      })
    )
  )
);

const useFakeTurnServices = () => fakeTurnServices;

export class PersonalAgent extends LivePersonalAgent {
  protected override readonly turnServices = useFakeTurnServices;
}
