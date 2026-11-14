import { generateText } from "ai";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { Context, Effect, Layer, Schedule } from "effect";

import { ModelProvider } from "./model-provider.ts";
import type { ModelTask } from "./model-provider.ts";
import { ModelUnavailable } from "./model-unavailable.ts";
import { UsageLedger } from "./usage-ledger.ts";
import type { Usage } from "./usage-ledger.ts";

export interface ModelRequest {
  readonly task: ModelTask;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
}

export interface ModelReply {
  readonly text: string;
  readonly usage: Usage;
}

export const modelAttempts = 3;
const attemptTimeout = "30 seconds";
const firstRetryDelay = "1 second";

const usageOf = (usage: LanguageModelUsage): Usage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
  costUsd: undefined,
});

const modelIdOf = (
  model: ReturnType<ModelProvider["Service"]["languageModel"]>
) => (typeof model === "string" ? model : model.modelId);

const makeModelGateway = Effect.gen(function* makeModelGatewayEffect() {
  const provider = yield* ModelProvider;
  const ledger = yield* UsageLedger;

  const attempt = (request: ModelRequest) => {
    const model = provider.languageModel(request.task);
    return Effect.tryPromise({
      try: (abortSignal) =>
        generateText({
          model,
          system: request.system,
          messages: [...request.messages],
          maxRetries: 0,
          abortSignal,
        }),
      catch: (cause) => new ModelUnavailable({ cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: attemptTimeout,
        orElse: () => Effect.fail(new ModelUnavailable({ cause: "timeout" })),
      }),
      Effect.tap((result) =>
        ledger.record(request.task, modelIdOf(model), usageOf(result.usage))
      ),
      Effect.map((result): ModelReply => ({
        text: result.text,
        usage: usageOf(result.usage),
      }))
    );
  };

  const generate = (request: ModelRequest) =>
    attempt(request).pipe(
      Effect.retry({
        times: modelAttempts - 1,
        schedule: Schedule.exponential(firstRetryDelay),
      })
    );

  return { generate };
});

export class ModelGateway extends Context.Service<
  ModelGateway,
  Effect.Success<typeof makeModelGateway>
>()("ModelGateway") {
  static readonly layer = Layer.effect(ModelGateway, makeModelGateway);
}
