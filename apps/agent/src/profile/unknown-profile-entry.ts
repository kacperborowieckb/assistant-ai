import { Data } from "effect";

export class UnknownProfileEntry extends Data.TaggedError(
  "UnknownProfileEntry"
)<{ readonly entryId: string }> {}
