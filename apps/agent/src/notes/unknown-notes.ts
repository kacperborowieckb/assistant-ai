import { Data } from "effect";

export class UnknownNotes extends Data.TaggedError("UnknownNotes")<{
  readonly noteIds: readonly string[];
}> {}
