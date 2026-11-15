import { Data } from "effect";

import type { ReasoningEffort } from "./model-provider.ts";
import type { ModelStep } from "./model-step.ts";

export class StepLimitReached extends Data.TaggedError("StepLimitReached")<{
  readonly modelId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly stepLimit: number;
  readonly steps: readonly ModelStep[];
}> {}
