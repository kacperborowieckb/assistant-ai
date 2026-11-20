import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { BurstSplit, checkBurstSend } from "./burst-split.ts";

const quiet = defaultBehaviorConfig.burstQuietMillis;

const sendExit = (messageCount: number, sendMillis: number) =>
  Effect.runSync(Effect.exit(checkBurstSend({ messageCount, sendMillis })));

describe("checkBurstSend", () => {
  it("passes a Burst sent within the Quiet Gap", () => {
    expect(Exit.isSuccess(sendExit(3, quiet - 1))).toBe(true);
  });

  it("fails a Burst whose send took the whole Quiet Gap", () => {
    expect(sendExit(3, quiet)).toStrictEqual(
      Exit.fail(new BurstSplit({ sendMillis: quiet }))
    );
  });

  it("fails a Burst whose send took longer than the Quiet Gap", () => {
    expect(sendExit(3, quiet + 1)).toStrictEqual(
      Exit.fail(new BurstSplit({ sendMillis: quiet + 1 }))
    );
  });

  it("passes a single message however long its send took", () => {
    expect(Exit.isSuccess(sendExit(1, quiet + 1))).toBe(true);
  });
});
