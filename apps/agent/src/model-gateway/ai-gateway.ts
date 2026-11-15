import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { Layer, Schema } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { ModelProvider } from "./model-provider.ts";
import type { ModelTask, ReasoningEffort } from "./model-provider.ts";

export interface ModelRoute {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
}

export interface AiGatewayConfig {
  readonly url: string;
  readonly gatewayId: string;
  readonly routes: Readonly<Record<ModelTask, ModelRoute>>;
  readonly fetch?: typeof fetch;
}

export const BillingModeSchema = Schema.Literals(["unified-billing", "byok"]);

export type BillingMode = typeof BillingModeSchema.Type;

export interface ModelCredentials {
  readonly token: string;
  readonly billing: BillingMode;
}

const providerName = "cloudflare-ai-gateway";

const billingHeaders = (billing: BillingMode): Record<string, string> =>
  billing === "byok" ? { "cf-aig-no-wholesale": "true" } : {};

export const aiGatewayHeaders = (
  gatewayId: string,
  credentials: ModelCredentials,
  ownerId: OwnerId
): Record<string, string> => ({
  "cf-aig-gateway-id": gatewayId,
  "cf-aig-metadata": JSON.stringify({ ownerId }),
  "cf-aig-collect-log-payload": "false",
  ...billingHeaders(credentials.billing),
});

export const aiGatewayModelProvider = (
  config: AiGatewayConfig,
  credentials: ModelCredentials,
  ownerId: OwnerId
) => {
  const provider = createOpenAICompatible({
    name: providerName,
    baseURL: config.url,
    apiKey: credentials.token,
    headers: aiGatewayHeaders(config.gatewayId, credentials, ownerId),
    includeUsage: true,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  return Layer.succeed(ModelProvider, {
    route: (task) => {
      const { model, reasoningEffort } = config.routes[task];
      return {
        reasoningEffort,
        model: wrapLanguageModel({
          model: provider.chatModel(model),
          middleware: defaultSettingsMiddleware({
            settings: {
              providerOptions: { [providerName]: { reasoningEffort } },
            },
          }),
        }),
      };
    },
  });
};
