import { Data } from "effect";

import type { ReasoningEffort } from "./model-provider.ts";
import type { ModelStep } from "./model-step.ts";

export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly modelId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly cause: unknown;
  readonly steps: readonly ModelStep[];
}> {}
