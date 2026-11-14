import { env } from "cloudflare:workers";
import { Layer } from "effect";

import { telegramChannel } from "../src/channels/telegram/telegram-channel.ts";
import { ModelGateway } from "../src/model-gateway/model-gateway.ts";
import { ModelProvider } from "../src/model-gateway/model-provider.ts";
import { PersonalAgent as LivePersonalAgent } from "../src/personal-agent/personal-agent.ts";
import type { TurnServices } from "../src/personal-agent/personal-agent.ts";
import { fakeModel, fakeTelegram, fakeTelegramApiUrl } from "./fakes.ts";

export { default } from "../src/index.ts";

const fakeTurnServices: TurnServices = Layer.merge(
  telegramChannel({
    apiUrl: fakeTelegramApiUrl,
    botToken: env.TELEGRAM_BOT_TOKEN,
    fetch: fakeTelegram.fetch,
  }),
  ModelGateway.layer.pipe(
    Layer.provide(
      Layer.succeed(ModelProvider, { languageModel: () => fakeModel })
    )
  )
);

const useFakeTurnServices = () => fakeTurnServices;

export class PersonalAgent extends LivePersonalAgent {
  protected override readonly turnServices = useFakeTurnServices;
}
