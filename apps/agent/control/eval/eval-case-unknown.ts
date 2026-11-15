import { Data } from "effect";

export class EvalCaseUnknown extends Data.TaggedError("EvalCaseUnknown")<{
  readonly names: readonly string[];
  readonly known: readonly string[];
}> {
  override get message() {
    return `No Eval Case is named ${this.names.join(", ")}. Known cases: ${this.known.join(", ") || "none"}.`;
  }
}
