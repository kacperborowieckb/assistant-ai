import { Data } from "effect";

export class EvalWorkerFailed extends Data.TaggedError("EvalWorkerFailed")<{
  readonly route: string;
  readonly detail: string;
}> {
  override get message() {
    return `The local eval Worker failed on ${this.route}: ${this.detail}`;
  }
}
