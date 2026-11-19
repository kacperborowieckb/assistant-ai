import { Data } from "effect";

export class NoOpenLoop extends Data.TaggedError("NoOpenLoop")<{
  readonly noteId: string;
}> {}
