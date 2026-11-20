import type { JSONValue, ModelMessage } from "ai";
import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { ModelRequest } from "../model-gateway/model-gateway.ts";
import type {
  ModelStep,
  PendingToolCall,
} from "../model-gateway/model-step.ts";
import { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import { StepLimitReached } from "../model-gateway/step-limit-reached.ts";
import { sumUsage } from "../model-gateway/usage-ledger.ts";
import {
  defaultReactionAllowed,
  refusalOfOutcomeTool,
} from "./outcome-refusal.ts";
import {
  reactionAcceptedOutput,
  reactionFor,
  requestedEmojiOf,
} from "./react-tool.ts";
import { silenceAcceptedOutput } from "./stay-silent-tool.ts";
import type { OutcomeKind } from "./storage-values.ts";
import type {
  ModelFailure,
  ModelOutcome,
  ReactionOutcome,
} from "./turn-record.ts";

export interface DecidedOutcome {
  readonly outcome: ModelOutcome;
  readonly kind: OutcomeKind | undefined;
  readonly reaction?: ReactionOutcome;
  readonly refusedOutcomeTools: readonly string[];
}

const toolResultMessage = (
  call: PendingToolCall,
  output: JSONValue
): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: call.callId,
      toolName: call.name,
      output:
        typeof output === "string"
          ? { type: "text", value: output }
          : { type: "json", value: output },
    },
  ],
});

interface OutcomeToolResults {
  readonly calls: readonly PendingToolCall[];
  readonly output: JSONValue;
  readonly refused: boolean;
}

const closeLastStep = (
  steps: readonly ModelStep[],
  { calls, output, refused }: OutcomeToolResults
): readonly ModelStep[] => {
  const last = steps.at(-1);
  if (last === undefined) {
    return steps;
  }
  const outputText =
    typeof output === "string" ? output : JSON.stringify(output);
  return [
    ...steps.slice(0, -1),
    {
      ...last,
      toolCalls: [
        ...last.toolCalls,
        ...calls.map((call) => ({
          callId: call.callId,
          name: call.name,
          input: call.input,
          output: outputText,
          failed: refused,
        })),
      ],
      responseMessages: [
        ...last.responseMessages,
        ...calls.map((call) => toolResultMessage(call, output)),
      ],
    },
  ];
};

const withEarlierSteps = (
  error: ModelFailure,
  earlier: readonly ModelStep[]
): ModelFailure =>
  error._tag === "StepLimitReached"
    ? new StepLimitReached({
        modelId: error.modelId,
        reasoningEffort: error.reasoningEffort,
        stepLimit: error.stepLimit,
        steps: [...earlier, ...error.steps],
      })
    : new ModelUnavailable({
        modelId: error.modelId,
        reasoningEffort: error.reasoningEffort,
        cause: error.cause,
        steps: [...earlier, ...error.steps],
      });

interface OutcomeGeneration {
  readonly eventId: string;
  readonly earlierMessages: readonly ModelMessage[];
  readonly request: ModelRequest;
  readonly tools: AgentTools;
  readonly defaultReaction: string;
}

export const generateWithOutcomeTools = Effect.fnUntraced(
  function* generateWithOutcomeTools({
    eventId,
    earlierMessages,
    request,
    tools,
    defaultReaction,
  }: OutcomeGeneration) {
    const modelGateway = yield* ModelGateway;
    const channel = yield* Channel;
    let earlier: readonly ModelStep[] = [];
    const refused: string[] = [];

    for (;;) {
      const stepLimit = request.stepLimit - earlier.length;
      const generated = yield* modelGateway
        .generate({
          ...request,
          messages: [
            ...request.messages,
            ...earlier.flatMap((step) => step.responseMessages),
          ],
          stepLimit,
        })
        .pipe(
          Effect.map((reply) => ({ _tag: "Replied", reply }) as const),
          Effect.catchTags({
            ModelUnavailable: (error) =>
              Effect.succeed({ _tag: "ModelFailed", error } as const),
            StepLimitReached: (error) =>
              Effect.succeed({ _tag: "ModelFailed", error } as const),
          })
        );
      if (generated._tag === "ModelFailed") {
        return {
          outcome: {
            _tag: "ModelFailed",
            error: withEarlierSteps(generated.error, earlier),
          },
          kind: undefined,
          refusedOutcomeTools: refused,
        } satisfies DecidedOutcome;
      }
      const { reply } = generated;
      const steps = [...earlier, ...reply.steps];
      const replied = (
        finalSteps: readonly ModelStep[],
        kind: OutcomeKind,
        reaction?: ReactionOutcome
      ): DecidedOutcome => ({
        outcome: {
          _tag: "Replied",
          reply: {
            ...reply,
            steps: finalSteps,
            usage: sumUsage(finalSteps.map((step) => step.usage)),
          },
        },
        kind,
        ...(reaction === undefined ? {} : { reaction }),
        refusedOutcomeTools: refused,
      });
      const calls = reply.endedWith;
      if (calls.length === 0) {
        const reactionInstead =
          reply.text.trim().length === 0 &&
          (yield* defaultReactionAllowed({
            eventId,
            steps,
            earlierMessages,
            tools,
          }));
        return reactionInstead
          ? replied(steps, "reaction", { emoji: defaultReaction })
          : replied(steps, "reply");
      }
      const refusals: readonly (string | undefined)[] = yield* Effect.all(
        calls.map((call) =>
          refusalOfOutcomeTool({
            eventId,
            name: call.name,
            steps,
            earlierMessages,
            tools,
          })
        )
      );
      const refusal = refusals.find((found) => found !== undefined);
      if (refusal === undefined) {
        const requested = requestedEmojiOf(calls);
        if (requested === undefined) {
          return replied(
            closeLastStep(steps, {
              calls,
              output: silenceAcceptedOutput,
              refused: false,
            }),
            "silent"
          );
        }
        const reaction = reactionFor(
          requested,
          channel.allowedReaction,
          defaultReaction
        );
        return replied(
          closeLastStep(steps, {
            calls,
            output: reactionAcceptedOutput(reaction.emoji),
            refused: false,
          }),
          "reaction",
          reaction
        );
      }
      refused.push(...calls.map((call) => call.name));
      earlier = closeLastStep(steps, { calls, output: refusal, refused: true });
      if (earlier.length >= request.stepLimit) {
        return {
          outcome: {
            _tag: "ModelFailed",
            error: new StepLimitReached({
              modelId: reply.modelId,
              reasoningEffort: reply.reasoningEffort,
              stepLimit: request.stepLimit,
              steps: earlier,
            }),
          },
          kind: undefined,
          refusedOutcomeTools: refused,
        } satisfies DecidedOutcome;
      }
    }
  }
);
