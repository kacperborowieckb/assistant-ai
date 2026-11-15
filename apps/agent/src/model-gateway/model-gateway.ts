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
  readonly modelId: string;
  readonly text: string;
  readonly usage: Usage;
}

export const modelAttempts = 3;
export const attemptTimeoutMillis = 30_000;
const attemptTimeout = `${attemptTimeoutMillis} millis` as const;
const firstRetryDelay = "1 second";

const usageOf = (usage: LanguageModelUsage): Usage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
  costUsd: undefined,
});

type LanguageModelRef = ReturnType<ModelProvider["Service"]["languageModel"]>;

const modelIdOf = (model: LanguageModelRef) =>
  typeof model === "string" ? model : model.modelId;

const attemptModelCall = (request: ModelRequest, model: LanguageModelRef) => {
  const modelId = modelIdOf(model);
  return Effect.tryPromise({
    try: (abortSignal) =>
      generateText({
        model,
        system: request.system,
        messages: [...request.messages],
        maxRetries: 0,
        abortSignal,
      }),
    catch: (cause) => new ModelUnavailable({ modelId, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: attemptTimeout,
      orElse: () =>
        Effect.fail(new ModelUnavailable({ modelId, cause: "timeout" })),
    })
  );
};

const makeModelGateway = Effect.gen(function* makeModelGatewayEffect() {
  const provider = yield* ModelProvider;
  const ledger = yield* UsageLedger;

  const generate = (request: ModelRequest) => {
    const model = provider.languageModel(request.task);
    return attemptModelCall(request, model).pipe(
      Effect.retry({
        times: modelAttempts - 1,
        schedule: Schedule.exponential(firstRetryDelay),
      }),
      Effect.tap((result) =>
        ledger.record(request.task, modelIdOf(model), usageOf(result.usage))
      ),
      Effect.map((result): ModelReply => ({
        modelId: modelIdOf(model),
        text: result.text,
        usage: usageOf(result.usage),
      }))
    );
  };

  return { generate };
});

export class ModelGateway extends Context.Service<
  ModelGateway,
  Effect.Success<typeof makeModelGateway>
>()("ModelGateway") {
  static readonly layer = Layer.effect(ModelGateway, makeModelGateway);
}
