import { Data } from "effect";

export class DirectoryUnavailable extends Data.TaggedError(
  "DirectoryUnavailable"
)<{ readonly cause: unknown }> {}
