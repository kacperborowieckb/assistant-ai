import { generateText } from "ai";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { Context, Effect, Layer, Schedule } from "effect";

import { ModelProvider } from "./model-provider.ts";
import type {
  ModelTask,
  ReasoningEffort,
  ResolvedRoute,
} from "./model-provider.ts";
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
  readonly reasoningEffort: ReasoningEffort;
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

const modelIdOf = (model: ResolvedRoute["model"]) =>
  typeof model === "string" ? model : model.modelId;

const attemptModelCall = (request: ModelRequest, route: ResolvedRoute) => {
  const { model, reasoningEffort } = route;
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
    catch: (cause) => new ModelUnavailable({ modelId, reasoningEffort, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: attemptTimeout,
      orElse: () =>
        Effect.fail(
          new ModelUnavailable({ modelId, reasoningEffort, cause: "timeout" })
        ),
    })
  );
};

const makeModelGateway = Effect.gen(function* makeModelGatewayEffect() {
  const provider = yield* ModelProvider;
  const ledger = yield* UsageLedger;

  const generate = (request: ModelRequest) => {
    const route = provider.route(request.task);
    const modelId = modelIdOf(route.model);
    return attemptModelCall(request, route).pipe(
      Effect.retry({
        times: modelAttempts - 1,
        schedule: Schedule.exponential(firstRetryDelay),
      }),
      Effect.tap((result) =>
        ledger.record(request.task, modelId, usageOf(result.usage))
      ),
      Effect.map((result): ModelReply => ({
        modelId,
        reasoningEffort: route.reasoningEffort,
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
