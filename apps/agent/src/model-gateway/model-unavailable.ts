import { Data } from "effect";

import type { ReasoningEffort } from "./model-provider.ts";

export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly modelId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly cause: unknown;
}> {}
