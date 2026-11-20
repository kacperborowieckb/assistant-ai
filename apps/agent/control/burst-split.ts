import { Data } from "effect";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";

export class BurstSplit extends Data.TaggedError("BurstSplit")<{
  readonly sendMillis: number;
}> {
  override get message() {
    return `Sending the Burst took ${this.sendMillis} ms, longer than the Quiet Gap of ${defaultBehaviorConfig.burstQuietMillis} ms, so the agent may have answered it in more than one Turn.`;
  }
}
