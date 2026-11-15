import { Data } from "effect";

export class TurnUnfinished extends Data.TaggedError("TurnUnfinished")<{
  readonly ownerText: string;
  readonly timeoutMillis: number;
}> {
  override get message() {
    return `The Turn for "${this.ownerText}" did not finish within ${this.timeoutMillis / 1000} seconds.`;
  }
}
