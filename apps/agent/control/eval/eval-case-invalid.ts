import { Data } from "effect";

export class EvalCaseInvalid extends Data.TaggedError("EvalCaseInvalid")<{
  readonly file: string;
  readonly issue: string;
}> {
  override get message() {
    return `The Eval Case file ${this.file} is invalid:\n${this.issue}`;
  }
}
