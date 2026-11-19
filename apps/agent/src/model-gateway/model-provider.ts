import type { LanguageModel } from "ai";
import { Context, Schema } from "effect";

import type { modelTasks } from "../personal-agent/storage-values.ts";

export type ModelTask = (typeof modelTasks)[number];

export const ReasoningEffortSchema = Schema.Literals([
  "none",
  "low",
  "medium",
  "high",
]);

export type ReasoningEffort = typeof ReasoningEffortSchema.Type;

export interface ResolvedRoute {
  readonly model: Extract<
    LanguageModel,
    { readonly specificationVersion: "v4" }
  >;
  readonly reasoningEffort: ReasoningEffort;
}

export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly route: (task: ModelTask) => ResolvedRoute }
>()("ModelProvider") {}
