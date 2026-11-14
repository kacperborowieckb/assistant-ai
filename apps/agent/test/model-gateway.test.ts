import { generateText } from "ai";
import { env } from "cloudflare:test";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  aiGatewayHeaders,
  aiGatewayModelProvider,
} from "../src/model-gateway/ai-gateway.ts";
import { ModelProvider } from "../src/model-gateway/model-provider.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { decodeTurnEnv } from "../src/personal-agent/turn-services.ts";

const chatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_794_000_000,
  model: "anthropic/claude-sonnet-5-5",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

describe("Model Gateway transport", () => {
  it("calls the model through the AI Gateway with the Owner Id metadata and no stored bodies", async () => {
    const requests: Request[] = [];
    const recordingFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json(chatCompletion));
    };
    const provider = aiGatewayModelProvider(
      {
        url: "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1",
        gatewayId: "assistant",
        models: { reply: "anthropic/claude-sonnet-5-5" },
        fetch: recordingFetch,
      },
      { token: "gateway-token", billing: "unified-billing" },
      OwnerIdSchema.make("owner-7")
    );

    const reply = await Effect.runPromise(
      ModelProvider.pipe(
        Effect.flatMap((models) =>
          Effect.promise(() =>
            generateText({ model: models.languageModel("reply"), prompt: "Hi" })
          )
        ),
        Effect.provide(provider)
      )
    );

    expect(reply.text).toBe("Hi there");
    const [request] = requests;
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions"
    );
    expect(request?.headers.get("Authorization")).toBe("Bearer gateway-token");
    expect(request?.headers.get("cf-aig-gateway-id")).toBe("assistant");
    expect(request?.headers.get("cf-aig-metadata")).toBe(
      JSON.stringify({ ownerId: "owner-7" })
    );
    expect(request?.headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(request?.headers.has("cf-aig-no-wholesale")).toBe(false);
    expect(await request?.json()).toMatchObject({
      model: "anthropic/claude-sonnet-5-5",
    });
  });

  it("blocks the Unified Billing fallback when the billing mode is BYOK", () => {
    const headers = aiGatewayHeaders(
      "assistant",
      { token: "gateway-token", billing: "byok" },
      OwnerIdSchema.make("owner-7")
    );

    expect(headers["cf-aig-no-wholesale"]).toBe("true");
  });

  it("names the missing configuration without its values", async () => {
    const exit = await Effect.runPromiseExit(decodeTurnEnv(env));

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = JSON.stringify(exit);
    expect(failure).toContain("AI_GATEWAY_URL");
    expect(failure).not.toContain(env.AI_GATEWAY_TOKEN);
    expect(failure).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
});
