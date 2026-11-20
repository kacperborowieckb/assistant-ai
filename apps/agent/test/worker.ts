import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { z } from "zod";

import { telegramChannel } from "../src/channels/telegram/telegram-channel.ts";
import { agentTool, ToolFailed } from "../src/model-gateway/agent-tool.ts";
import type { AgentTools } from "../src/model-gateway/agent-tool.ts";
import { ModelGateway } from "../src/model-gateway/model-gateway.ts";
import { ModelProvider } from "../src/model-gateway/model-provider.ts";
import { oneEventBursts } from "../src/personal-agent/burst.ts";
import type { Burst, FormBursts } from "../src/personal-agent/burst.ts";
import { PersonalAgent as LivePersonalAgent } from "../src/personal-agent/personal-agent.ts";
import type { TurnServices } from "../src/personal-agent/personal-agent.ts";
import { OperatorMetrics } from "../src/tracing/operator-metrics.ts";
import { Redactor } from "../src/tracing/redactor.ts";
import {
  fakeBursts,
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  fakeTelegramApiUrl,
  fakeTool,
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

const fakeTools: AgentTools = {
  [fakeTool.name]: agentTool({
    description: "Keep a word",
    inputSchema: z.object({ word: z.string() }),
    execute: ({ word }) =>
      fakeTool.failWith === undefined
        ? Effect.sync(() => {
            fakeTool.kept.push(word);
            return { kept: word };
          })
        : Effect.fail(new ToolFailed({ message: fakeTool.failWith })),
  }),
};

const useFakeTurnServices = () => fakeTurnServices;

const fakeFormBursts: FormBursts = (events) => {
  const [first, ...rest] = events;
  if (!fakeBursts.allPendingTogether || first === undefined) {
    return oneEventBursts(events);
  }
  const burst: Burst = [first, ...rest];
  return [burst];
};

export class PersonalAgent extends LivePersonalAgent {
  protected override readonly turnServices = useFakeTurnServices;
  protected override readonly turnTools = fakeTools;
  protected override readonly formBursts = fakeFormBursts;
}
