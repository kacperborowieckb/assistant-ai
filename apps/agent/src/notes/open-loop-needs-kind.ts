import { Data } from "effect";

export class OpenLoopNeedsKind extends Data.TaggedError("OpenLoopNeedsKind")<{
  readonly noteId: string;
}> {}
