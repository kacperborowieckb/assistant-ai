import { Effect } from "effect";

import type { JudgeResult, ObservedUsage } from "../../eval/eval-contract.ts";
import type { OwnerNotAdded } from "../operator.ts";
import type { EvalCase } from "./eval-case.ts";
import { evaluateCodeCheck } from "./eval-checks.ts";
import type { CheckOutcome, EvalCheck } from "./eval-checks.ts";
import type { EvalWorkerFailed } from "./eval-worker-failed.ts";
import type { EvalRun } from "./local-eval-agent.ts";
import type { TurnUnfinished } from "./turn-unfinished.ts";

export interface EvalAgent {
  readonly runCase: (
    evalCase: EvalCase
  ) => Effect.Effect<
    EvalRun,
    TurnUnfinished | EvalWorkerFailed | OwnerNotAdded
  >;
  readonly judge: (
    run: EvalRun,
    rubric: string
  ) => Effect.Effect<JudgeResult, EvalWorkerFailed>;
}

export interface RunResult {
  readonly run: number;
  readonly outcomes: readonly CheckOutcome[];
  readonly usage: readonly ObservedUsage[];
}

export interface CaseResult {
  readonly name: string;
  readonly runs: readonly RunResult[];
}

export const runPassed = (result: RunResult) =>
  result.outcomes.every((outcome) => outcome.passed);

export const casePassed = (result: CaseResult) => result.runs.every(runPassed);

interface CheckResult {
  readonly outcome: CheckOutcome;
  readonly usage: readonly ObservedUsage[];
}

const checkRun = (
  agent: EvalAgent,
  run: EvalRun,
  check: EvalCheck
): Effect.Effect<CheckResult, EvalWorkerFailed> =>
  check.check === "reply_judged"
    ? agent.judge(run, check.rubric).pipe(
        Effect.map((judged) => ({
          outcome: {
            label: "reply_judged: the judge model applies the rubric",
            passed: judged.passed,
            detail: judged.reason,
          },
          usage: judged.usage,
        }))
      )
    : Effect.succeed({
        outcome: evaluateCodeCheck(check, run.observation),
        usage: [],
      });

const runOnce = (
  agent: EvalAgent,
  evalCase: EvalCase,
  run: number
): Effect.Effect<RunResult, EvalWorkerFailed | OwnerNotAdded> =>
  agent.runCase(evalCase).pipe(
    Effect.flatMap((evalRun) =>
      Effect.all(
        evalCase.checks.map((check) => checkRun(agent, evalRun, check))
      ).pipe(
        Effect.map((checked): RunResult => ({
          run,
          outcomes: checked.map((result) => result.outcome),
          usage: [
            ...evalRun.observation.usage,
            ...checked.flatMap((result) => result.usage),
          ],
        }))
      )
    ),
    Effect.catchTag("TurnUnfinished", (unfinished) =>
      Effect.succeed<RunResult>({
        run,
        outcomes: [
          {
            label: "every Turn finishes",
            passed: false,
            detail: unfinished.message,
          },
        ],
        usage: unfinished.usage,
      })
    )
  );

export const runEvalCase = (agent: EvalAgent, evalCase: EvalCase, k: number) =>
  Effect.all(
    Array.from({ length: k }, (_, index) => runOnce(agent, evalCase, index + 1))
  ).pipe(Effect.map((runs): CaseResult => ({ name: evalCase.name, runs })));
