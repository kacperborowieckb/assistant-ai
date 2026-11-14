import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Channel } from "../src/channels/channel.ts";
import {
  telegramChannel,
  telegramParts,
  telegramTextLimit,
} from "../src/channels/telegram/telegram-channel.ts";

const fakeTelegramApi = (refuseFrom = Number.POSITIVE_INFINITY) => {
  const texts: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Request(input, init).json<{ text: string }>();
    texts.push(body.text);
    if (texts.length >= refuseFrom) {
      return Response.json(
        { ok: false, description: "Bad Request: message is too long" },
        { status: 400 }
      );
    }
    return Response.json({ ok: true, result: { message_id: texts.length } });
  };
  return { texts, fetch };
};

const sendWith = (api: ReturnType<typeof fakeTelegramApi>, text: string) =>
  Effect.runPromise(
    Channel.pipe(
      Effect.flatMap((channel) =>
        channel.send({ conversationId: "1", inReplyTo: "2", text })
      ),
      Effect.provide(
        telegramChannel({
          apiUrl: "https://telegram.fake",
          botToken: "token",
          fetch: api.fetch,
        })
      )
    )
  );

describe("Telegram message parts", () => {
  it("keeps a reply at the limit in one message", () => {
    const text = "a".repeat(telegramTextLimit);

    expect(telegramParts(text)).toEqual([text]);
  });

  it("splits a long reply at spaces into parts within the limit", () => {
    const words = Array.from({ length: 1500 }, (_, index) => `word${index}`);
    const parts = telegramParts(words.join(" "));

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(telegramTextLimit);
    }
    expect(parts.join(" ")).toBe(words.join(" "));
  });

  it("never makes an empty or blank part", () => {
    const full = "a".repeat(telegramTextLimit);

    expect(telegramParts(`${full} `)).toEqual([full]);
    expect(telegramParts(`${full}${" ".repeat(20)}\n `)).toEqual([full]);
    expect(telegramParts(`  ${"b".repeat(telegramTextLimit + 5)}`)).toEqual([
      "b".repeat(telegramTextLimit),
      "b".repeat(5),
    ]);
  });

  it("cuts text without spaces at the limit and keeps emoji whole", () => {
    const text = `${"a".repeat(telegramTextLimit - 1)}😀${"b".repeat(10)}`;
    const parts = telegramParts(text);

    expect(parts).toEqual([
      "a".repeat(telegramTextLimit - 1),
      `😀${"b".repeat(10)}`,
    ]);
  });
});

describe("Telegram send", () => {
  it("confirms a long reply only after every part is confirmed", async () => {
    const api = fakeTelegramApi();

    const delivery = await sendWith(api, "x ".repeat(telegramTextLimit));

    expect(api.texts).toHaveLength(2);
    expect(delivery).toEqual({ _tag: "Confirmed", channelMessageId: "2" });
  });

  it("reports a failed part as a failed delivery", async () => {
    const api = fakeTelegramApi(2);

    const delivery = await sendWith(api, "x ".repeat(telegramTextLimit));

    expect(delivery).toEqual({
      _tag: "Failed",
      reason:
        "Part 2 of 2: Telegram refused the message (400): Bad Request: message is too long",
    });
  });
});
