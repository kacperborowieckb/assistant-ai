import { Data } from "effect";

export class OperatorTokenMissing extends Data.TaggedError(
  "OperatorTokenMissing"
)<{ readonly message: string }> {}
