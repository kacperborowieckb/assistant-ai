import { Data } from "effect";

import type { ObservedUsage } from "../../eval/eval-contract.ts";

export class TurnUnfinished extends Data.TaggedError("TurnUnfinished")<{
  readonly ownerText: string;
  readonly timeoutMillis: number;
  readonly usage: readonly ObservedUsage[];
}> {
  override get message() {
    return `The Turn for "${this.ownerText}" did not finish within ${this.timeoutMillis / 1000} seconds.`;
  }
}
