import { Effect, Layer, Option, Schema } from "effect";

import { ModelGateway } from "../src/model-gateway/model-gateway.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import type { Usage } from "../src/model-gateway/usage-ledger.ts";
import type { OwnerId } from "../src/owner-id.ts";
import {
  decodeTurnEnv,
  liveModelGateway,
} from "../src/personal-agent/turn-services.ts";
import type {
  Exchange,
  JudgeRequest,
  JudgeResult,
  ObservedUsage,
} from "./eval-contract.ts";

export const judgeInstructions = [
  "You are the judge of an Eval. You read a conversation between an Owner and their personal agent, and a rubric.",
  "Decide if the agent's replies meet every point of the rubric. Judge only the agent's replies, not the Owner's messages.",
  'Answer with one JSON object and nothing else: {"verdict": "pass" or "fail", "reason": "one short sentence"}.',
].join("\n");

const exchangeLines = (exchange: Exchange) => [
  exchange.forwardedFrom === undefined
    ? `Owner: ${exchange.ownerText}`
    : `Owner (forwarded a message from ${exchange.forwardedFrom}): ${exchange.ownerText}`,
  `Agent: ${exchange.agentReply ?? "(no reply)"}`,
];

export const judgePrompt = ({ rubric, exchanges }: JudgeRequest) =>
  [
    "Rubric:",
    rubric,
    "",
    "Conversation:",
    ...exchanges.flatMap(exchangeLines),
  ].join("\n");

const JudgeAnswerSchema = Schema.fromJsonString(
  Schema.Struct({
    verdict: Schema.Literals(["pass", "fail"]),
    reason: Schema.String,
  })
);

const jsonObjectIn = (text: string) =>
  text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);

const verdictOf = (text: string) =>
  Schema.decodeUnknownOption(JudgeAnswerSchema)(jsonObjectIn(text)).pipe(
    Option.match({
      onNone: () => ({
        passed: false,
        reason: `The judge did not answer with a verdict: ${text}`,
      }),
      onSome: ({ verdict, reason }) => ({ passed: verdict === "pass", reason }),
    })
  );

const observedJudgeUsage = (usage: Usage): ObservedUsage => ({
  task: "eval_judge",
  inputTokens: usage.inputTokens ?? null,
  outputTokens: usage.outputTokens ?? null,
  cachedInputTokens: usage.cachedInputTokens ?? null,
  costUsd: usage.costUsd ?? null,
});

const collectedUsageLedger = (collected: Usage[]) =>
  Layer.succeed(UsageLedger, {
    record: (_task, _modelId, usage) =>
      Effect.sync(() => {
        collected.push(usage);
      }),
    read: Effect.succeed([]),
  });

export const judgeExchanges = (
  env: Env,
  ownerId: OwnerId,
  request: JudgeRequest
) =>
  Effect.gen(function* judgeExchangesEffect() {
    const config = yield* decodeTurnEnv(env);
    const collected: Usage[] = [];
    const verdict = yield* ModelGateway.pipe(
      Effect.flatMap((gateway) =>
        gateway.generate({
          task: "eval_judge",
          system: judgeInstructions,
          messages: [{ role: "user", content: judgePrompt(request) }],
          stepLimit: 1,
        })
      ),
      Effect.map((reply) => verdictOf(reply.text)),
      Effect.catchTags({
        ModelUnavailable: (error) =>
          Effect.succeed({
            passed: false,
            reason: `The judge model failed: ${String(error.cause)}`,
          }),
        StepLimitReached: () =>
          Effect.succeed({
            passed: false,
            reason: "The judge model called a tool instead of answering.",
          }),
      }),
      Effect.provide(
        liveModelGateway(config, ownerId).pipe(
          Layer.provide(collectedUsageLedger(collected))
        )
      )
    );
    return {
      ...verdict,
      usage: collected.map(observedJudgeUsage),
    } satisfies JudgeResult;
  });
