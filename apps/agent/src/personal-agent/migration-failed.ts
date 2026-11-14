import { Data } from "effect";

export class MigrationFailed extends Data.TaggedError("MigrationFailed")<{
  readonly cause: unknown;
}> {}
