import type { ObservedUsage } from "../../eval/eval-contract.ts";
import { defaultBehaviorConfig } from "../../src/behavior/behavior-config.ts";
import { modelAttempts } from "../../src/model-gateway/model-call-policy.ts";
import type { EvalCase } from "./eval-case.ts";
import { casePassed, runPassed } from "./run-eval.ts";
import type { CaseResult } from "./run-eval.ts";

export interface ModelCallEstimate {
  readonly least: number;
  readonly most: number;
}

const judgeCheckCount = (evalCase: EvalCase) =>
  evalCase.checks.filter((check) => check.check === "reply_judged").length;

export const modelCallEstimate = (
  cases: readonly EvalCase[],
  k: number
): ModelCallEstimate => {
  const perRun = cases.map((evalCase) => ({
    least: evalCase.events.length + judgeCheckCount(evalCase),
    most:
      evalCase.events.length * defaultBehaviorConfig.maxToolSteps +
      judgeCheckCount(evalCase),
  }));
  return {
    least: k * perRun.reduce((total, run) => total + run.least, 0),
    most: k * perRun.reduce((total, run) => total + run.most, 0),
  };
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export const renderEvalPlan = (cases: readonly EvalCase[], k: number) => {
  const estimate = modelCallEstimate(cases, k);
  return [
    `Eval: ${plural(cases.length, "case")} (${cases.map((evalCase) => evalCase.name).join(", ")}), k = ${k}.`,
    `Expected model calls: ${estimate.least} to ${estimate.most} (each run: 1 to ${defaultBehaviorConfig.maxToolSteps} model steps for each Owner Event, and 1 call for each judge check). A failed call is tried up to ${modelAttempts} times.`,
    "The calls go to the real model through AI Gateway and cost money.",
  ].join("\n");
};

const sumOf = (values: readonly (number | null)[]) => {
  const known = values.filter((value) => value !== null);
  return known.length === 0
    ? "unknown"
    : String(known.reduce((total, value) => total + value, 0));
};

const tokensOf = (usage: readonly ObservedUsage[]) =>
  `${sumOf(usage.map((record) => record.inputTokens))} input (${sumOf(usage.map((record) => record.cachedInputTokens))} cached), ${sumOf(usage.map((record) => record.outputTokens))} output`;

const costOf = (usage: readonly ObservedUsage[]) => {
  const costs = usage.map((record) => record.costUsd);
  if (costs.length === 0 || costs.includes(null)) {
    return "unknown (Usage records no cost yet, see issue #27)";
  }
  return `${sumOf(costs)} USD`;
};

const renderCase = (result: CaseResult) => {
  const usage = result.runs.flatMap((run) => run.usage);
  const passedRuns = result.runs.filter(runPassed).length;
  const failedChecks = result.runs.flatMap((run) =>
    run.outcomes
      .filter((outcome) => !outcome.passed)
      .map(
        (outcome) =>
          `    Run ${run.run}: ${outcome.label}. Found: ${outcome.detail}`
      )
  );
  return [
    `${result.name}: ${casePassed(result) ? "PASS" : "FAIL"}, ${passedRuns} of ${result.runs.length} runs passed (pass^${result.runs.length})`,
    `  Tokens: agent ${tokensOf(usage.filter((record) => record.task === "reply"))}; judge ${tokensOf(usage.filter((record) => record.task === "eval_judge"))}`,
    `  Cost: ${costOf(usage)}`,
    ...(failedChecks.length === 0 ? [] : ["  Failed checks:", ...failedChecks]),
  ];
};

export const renderEvalReport = (results: readonly CaseResult[], k: number) =>
  [
    ...results.flatMap(renderCase),
    `Result: ${results.filter(casePassed).length} of ${plural(results.length, "case")} passed pass^${k}.`,
  ].join("\n");
