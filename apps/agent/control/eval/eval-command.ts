import { Console, Data, Effect, Option } from "effect";

import { startLocalFakes } from "../local-fakes.ts";
import { localValue } from "../local-values.ts";
import type { EvalCase } from "./eval-case.ts";
import { loadEvalCases } from "./eval-cases.ts";
import { renderEvalPlan, renderEvalReport } from "./eval-report.ts";
import { startLocalEvalAgent } from "./local-eval-agent.ts";
import type { FakeTelegramApi, ModelAccess } from "./local-eval-agent.ts";
import { casePassed, runEvalCase } from "./run-eval.ts";

export class ModelAccessMissing extends Data.TaggedError("ModelAccessMissing")<{
  readonly names: readonly string[];
}> {
  override get message() {
    return `Set ${this.names.join(" and ")} in the environment or in .dev.vars. The Eval calls the real model through AI Gateway.`;
  }
}

const modelAccessNames = ["AI_GATEWAY_URL", "AI_GATEWAY_TOKEN"] as const;

export const realModelAccess = Effect.suspend(() => {
  const url = localValue("AI_GATEWAY_URL");
  const token = localValue("AI_GATEWAY_TOKEN");
  return Option.isSome(url) && Option.isSome(token)
    ? Effect.succeed<ModelAccess>({
        aiGatewayUrl: url.value,
        aiGatewayToken: token.value,
      })
    : Effect.fail(
        new ModelAccessMissing({
          names: modelAccessNames.filter((name) =>
            Option.isNone(localValue(name))
          ),
        })
      );
});

export const runEval = ({
  cases,
  k,
  telegram,
  model,
}: {
  readonly cases: readonly EvalCase[];
  readonly k: number;
  readonly telegram: FakeTelegramApi;
  readonly model: ModelAccess;
}) =>
  startLocalEvalAgent({ telegram, model }).pipe(
    Effect.flatMap((agent) =>
      Effect.all(cases.map((evalCase) => runEvalCase(agent, evalCase, k)))
    )
  );

export const runEvalCommand = ({
  k,
  names,
}: {
  readonly k: number;
  readonly names: readonly string[];
}) =>
  Effect.gen(function* runEvalCommandEffect() {
    const cases = yield* loadEvalCases({ names });
    const model = yield* realModelAccess;
    yield* Console.log(renderEvalPlan(cases, k));
    const telegram = yield* startLocalFakes();
    const results = yield* runEval({ cases, k, telegram, model });
    yield* Console.log(renderEvalReport(results, k));
    return results.every(casePassed);
  }).pipe(Effect.scoped);
