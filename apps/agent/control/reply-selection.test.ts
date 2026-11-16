import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { FakeTelegramMessage } from "./local-fakes.ts";
import { selectReplyTo } from "./reply-selection.ts";

const message = (
  text: string,
  replyToMessageId: number | undefined
): FakeTelegramMessage => ({ chatId: 1, text, replyToMessageId });

const selectFrom = (arrivals: readonly FakeTelegramMessage[]) => {
  const queue = [...arrivals];
  return Effect.runPromise(
    selectReplyTo({
      inputMessageId: 9,
      take: () => Effect.succeed(Option.fromNullishOr(queue.shift())),
      firstReplyTimeout: "1 second",
      nextPartTimeout: "1 second",
    })
  );
};

describe("selectReplyTo", () => {
  it("keeps a Reminder that arrives before the reply apart from the reply", async () => {
    const selection = await selectFrom([
      message("buy the gift", undefined),
      message("Reminder set", 9),
    ]);

    expect(selection.replyParts.map((part) => part.text)).toEqual([
      "Reminder set",
    ]);
    expect(selection.unprompted.map((part) => part.text)).toEqual([
      "buy the gift",
    ]);
  });

  it("joins the parts of one reply and keeps a Reminder between them apart", async () => {
    const selection = await selectFrom([
      message("part one", 9),
      message("buy the gift", undefined),
      message("part two", 9),
    ]);

    expect(selection.replyParts.map((part) => part.text)).toEqual([
      "part one",
      "part two",
    ]);
    expect(selection.unprompted.map((part) => part.text)).toEqual([
      "buy the gift",
    ]);
  });

  it("does not take a reply to another input as the reply", async () => {
    const selection = await selectFrom([
      message("late answer to input 8", 8),
      message("answer", 9),
    ]);

    expect(selection.replyParts.map((part) => part.text)).toEqual(["answer"]);
    expect(selection.unprompted.map((part) => part.text)).toEqual([
      "late answer to input 8",
    ]);
  });
});
