import { Data } from "effect";

export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly modelId: string;
  readonly cause: unknown;
}> {}
