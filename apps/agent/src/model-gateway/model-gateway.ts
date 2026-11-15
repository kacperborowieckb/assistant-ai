import { generateText, isStepCount, wrapLanguageModel } from "ai";
import type { LanguageModelUsage, ModelMessage, StepResult, ToolSet } from "ai";
import { Context, Effect, Layer, Schedule } from "effect";

import { noTools, runToolEffect } from "./agent-tool.ts";
import type { AgentTools } from "./agent-tool.ts";
import { ModelCallFailed } from "./model-call-failed.ts";
import { ModelProvider } from "./model-provider.ts";
import type {
  ModelTask,
  ReasoningEffort,
  ResolvedRoute,
} from "./model-provider.ts";
import type { ModelStep, ModelToolCall } from "./model-step.ts";
import { ModelUnavailable } from "./model-unavailable.ts";
import { StepLimitReached } from "./step-limit-reached.ts";
import { UsageLedger } from "./usage-ledger.ts";
import type { Usage } from "./usage-ledger.ts";

export interface ModelRequest {
  readonly task: ModelTask;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: AgentTools;
  readonly stepLimit: number;
}

export interface ModelReply {
  readonly modelId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly text: string;
  readonly usage: Usage;
  readonly steps: readonly ModelStep[];
  readonly responseMessages: readonly ModelMessage[];
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

const sumDefined = (values: readonly (number | undefined)[]) => {
  const defined = values.filter((value) => value !== undefined);
  return defined.length === 0
    ? undefined
    : defined.reduce((total, value) => total + value, 0);
};

const sumUsage = (usages: readonly Usage[]): Usage => ({
  inputTokens: sumDefined(usages.map((usage) => usage.inputTokens)),
  outputTokens: sumDefined(usages.map((usage) => usage.outputTokens)),
  cachedInputTokens: sumDefined(usages.map((usage) => usage.cachedInputTokens)),
  costUsd: sumDefined(usages.map((usage) => usage.costUsd)),
});

const stringify = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "null");

const errorMessageOf = (error: unknown) =>
  error instanceof Error ? error.message : stringify(error);

const toolCallsOf = (step: StepResult<ToolSet>): readonly ModelToolCall[] =>
  step.content.flatMap((part): ModelToolCall[] => {
    if (part.type === "tool-result") {
      return [
        {
          name: part.toolName,
          input: stringify(part.input),
          output: stringify(part.output),
          failed: false,
        },
      ];
    }
    if (part.type === "tool-error") {
      return [
        {
          name: part.toolName,
          input: stringify(part.input),
          output: errorMessageOf(part.error),
          failed: true,
        },
      ];
    }
    return [];
  });

const modelStepOf = (step: StepResult<ToolSet>): ModelStep => ({
  usage: usageOf(step.usage),
  toolCalls: toolCallsOf(step),
});

const retryingModelCalls = (
  model: ResolvedRoute["model"]
): ResolvedRoute["model"] =>
  wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ params }) => {
        const attempt = Effect.tryPromise({
          try: (abortSignal) => model.doGenerate({ ...params, abortSignal }),
          catch: (cause) => new ModelCallFailed({ cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: attemptTimeout,
            orElse: () =>
              Effect.fail(new ModelCallFailed({ cause: "timeout" })),
          }),
          Effect.retry({
            times: modelAttempts - 1,
            schedule: Schedule.exponential(firstRetryDelay),
          })
        );
        const outcome = await Effect.runPromise(
          attempt.pipe(
            Effect.map((result) => ({ _tag: "Succeeded", result }) as const),
            Effect.catchTag("ModelCallFailed", (failure) =>
              Effect.succeed({ _tag: "Failed", cause: failure.cause } as const)
            )
          ),
          { signal: params.abortSignal }
        );
        if (outcome._tag === "Failed") {
          throw outcome.cause;
        }
        return outcome.result;
      },
    },
  });

const makeModelGateway = Effect.gen(function* makeModelGatewayEffect() {
  const provider = yield* ModelProvider;
  const ledger = yield* UsageLedger;

  const recordUsage = (
    task: ModelTask,
    modelId: string,
    steps: readonly ModelStep[]
  ) =>
    Effect.forEach(steps, (step) => ledger.record(task, modelId, step.usage), {
      discard: true,
    });

  const generate = (request: ModelRequest) =>
    Effect.gen(function* generateEffect() {
      const route = provider.route(request.task);
      const { modelId } = route.model;
      const { reasoningEffort } = route;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const runTool = runToolEffect(runPromise);
      const tools = Object.fromEntries(
        Object.entries(request.tools ?? noTools).map(([name, agentTool]) => [
          name,
          agentTool.toAiSdkTool(runTool),
        ])
      );
      const finishedSteps: StepResult<ToolSet>[] = [];

      const result = yield* Effect.tryPromise({
        try: (abortSignal) =>
          generateText({
            model: retryingModelCalls(route.model),
            system: request.system,
            messages: [...request.messages],
            tools,
            stopWhen: isStepCount(request.stepLimit),
            maxRetries: 0,
            abortSignal,
            onStepFinish: (step) => {
              finishedSteps.push(step);
            },
          }),
        catch: (cause) =>
          new ModelUnavailable({
            modelId,
            reasoningEffort,
            cause,
            steps: finishedSteps.map(modelStepOf),
          }),
      }).pipe(
        Effect.tapError((error) =>
          recordUsage(request.task, modelId, error.steps)
        )
      );

      const steps = result.steps.map(modelStepOf);
      yield* recordUsage(request.task, modelId, steps);

      if (result.steps.at(-1)?.finishReason === "tool-calls") {
        return yield* new StepLimitReached({
          modelId,
          reasoningEffort,
          stepLimit: request.stepLimit,
          steps,
        });
      }
      return {
        modelId,
        reasoningEffort,
        text: result.text,
        usage: sumUsage(steps.map((step) => step.usage)),
        steps,
        responseMessages: result.steps.flatMap(
          (step) => step.response.messages
        ),
      } satisfies ModelReply;
    });

  return { generate };
});

export class ModelGateway extends Context.Service<
  ModelGateway,
  Effect.Success<typeof makeModelGateway>
>()("ModelGateway") {
  static readonly layer = Layer.effect(ModelGateway, makeModelGateway);
}
