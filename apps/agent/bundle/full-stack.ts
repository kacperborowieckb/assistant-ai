import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { Effect, Schema } from "effect";

import { edge } from "../src/edge/edge.ts";

export { PersonalAgent } from "../src/personal-agent/personal-agent.ts";

const SampleUpdate = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.Struct({ text: Schema.String }),
});

const aiGateway = createOpenAICompatible({
  name: "cloudflare-ai-gateway",
  baseURL: "https://gateway.ai.cloudflare.com/v1/account/gateway/compat",
});

const replyTo = (body: unknown) =>
  Effect.gen(function* replyToEffect() {
    const update = yield* Schema.decodeUnknownEffect(SampleUpdate)(body);
    const reply = yield* Effect.promise(() =>
      generateText({
        model: aiGateway("workers-ai/@cf/meta/llama-3.1-8b-instruct"),
        prompt: update.message.text,
      })
    );
    return reply.text;
  });

export default {
  fetch: async (request, env, context) => {
    if (request.method !== "POST") {
      return edge.fetch(request, env, context);
    }
    const text = await Effect.runPromise(replyTo(await request.json()));
    return new Response(text);
  },
} satisfies ExportedHandler<Env>;
