import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Layer } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { ModelProvider } from "./model-provider.ts";
import type { ModelTask } from "./model-provider.ts";

export interface AiGatewayConfig {
  readonly url: string;
  readonly gatewayId: string;
  readonly models: Readonly<Record<ModelTask, string>>;
  readonly fetch?: typeof fetch;
}

export interface ModelCredentials {
  readonly token: string;
}

export const aiGatewayHeaders = (gatewayId: string, ownerId: OwnerId) => ({
  "cf-aig-gateway-id": gatewayId,
  "cf-aig-metadata": JSON.stringify({ ownerId }),
  "cf-aig-collect-log-payload": "false",
});

export const aiGatewayModelProvider = (
  config: AiGatewayConfig,
  credentials: ModelCredentials,
  ownerId: OwnerId
) => {
  const provider = createOpenAICompatible({
    name: "cloudflare-ai-gateway",
    baseURL: config.url,
    apiKey: credentials.token,
    headers: aiGatewayHeaders(config.gatewayId, ownerId),
    includeUsage: true,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  return Layer.succeed(ModelProvider, {
    languageModel: (task) => provider.chatModel(config.models[task]),
  });
};
