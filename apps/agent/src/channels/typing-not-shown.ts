import { Data } from "effect";

export class TypingNotShown extends Data.TaggedError("TypingNotShown")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}
