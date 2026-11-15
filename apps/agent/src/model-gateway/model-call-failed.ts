import { Data } from "effect";

export class ModelCallFailed extends Data.TaggedError("ModelCallFailed")<{
  readonly cause: unknown;
}> {}
