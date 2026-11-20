import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Channel } from "../src/channels/channel.ts";
import {
  telegramChannel,
  telegramParts,
  telegramTextLimit,
} from "../src/channels/telegram/telegram-channel.ts";
import {
  telegramCloseMatches,
  telegramReactionFor,
  telegramReactions,
} from "../src/channels/telegram/telegram-reactions.ts";

const fakeTelegramApi = (refuseFrom = Number.POSITIVE_INFINITY) => {
  const texts: string[] = [];
  const bodies: object[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Request(input, init).json<{ text: string }>();
    texts.push(body.text);
    bodies.push(body);
    if (texts.length >= refuseFrom) {
      return Response.json(
        { ok: false, description: "Bad Request: message is too long" },
        { status: 400 }
      );
    }
    return Response.json({ ok: true, result: { message_id: texts.length } });
  };
  return { texts, bodies, fetch };
};

const sendWith = (
  api: ReturnType<typeof fakeTelegramApi>,
  text: string,
  inReplyTo: string | null = "2"
) =>
  Effect.runPromise(
    Channel.pipe(
      Effect.flatMap((channel) =>
        channel.send({
          conversationId: "1",
          ...(inReplyTo === null ? {} : { inReplyTo }),
          text,
        })
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
  it("refuses a blank reply without calling Telegram", async () => {
    const api = fakeTelegramApi();

    const deliveries = await Promise.all(
      ["", "  \n ", " ".repeat(telegramTextLimit + 1)].map((text) =>
        sendWith(api, text)
      )
    );

    expect(deliveries).toEqual(
      Array.from({ length: 3 }, () => ({
        _tag: "Failed",
        reason: "The reply has no text",
      }))
    );
    expect(api.texts).toEqual([]);
  });

  it("sends a plain message with no reply parameters when there is no message to reply to", async () => {
    const api = fakeTelegramApi();

    await sendWith(api, "Reminder text", null);

    expect(api.bodies).toEqual([{ chat_id: 1, text: "Reminder text" }]);
  });

  it("sends reply parameters when there is a message to reply to", async () => {
    const api = fakeTelegramApi();

    await sendWith(api, "An answer");

    expect(api.bodies).toEqual([
      {
        chat_id: 1,
        text: "An answer",
        reply_parameters: { message_id: 2, allow_sending_without_reply: true },
      },
    ]);
  });

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

const showTypingWith = (
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) =>
  Effect.runPromise(
    Channel.pipe(
      Effect.flatMap((channel) => channel.showTyping("1")),
      Effect.match({
        onFailure: (error) => ({ _tag: error._tag, reason: error.reason }),
        onSuccess: () => ({ _tag: "Shown" }),
      }),
      Effect.provide(
        telegramChannel({
          apiUrl: "https://telegram.fake",
          botToken: "token",
          fetch,
        })
      )
    )
  );

describe("Telegram typing signal", () => {
  it("sends sendChatAction with typing to the chat", async () => {
    const requests: { url: string; body: unknown }[] = [];

    const result = await showTypingWith(async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.json() });
      return Response.json({ ok: true, result: true });
    });

    expect(result).toEqual({ _tag: "Shown" });
    expect(requests).toEqual([
      {
        url: "https://telegram.fake/bottoken/sendChatAction",
        body: { chat_id: 1, action: "typing" },
      },
    ]);
  });

  it("fails with the reason when Telegram refuses or cannot be reached", async () => {
    const refused = await showTypingWith(() =>
      Promise.resolve(
        Response.json(
          { ok: false, description: "Forbidden: bot was blocked by the user" },
          { status: 403 }
        )
      )
    );
    const unreachable = await showTypingWith(() =>
      Promise.reject(new TypeError("offline"))
    );

    expect(refused).toEqual({
      _tag: "TypingNotShown",
      reason:
        "Telegram refused the chat action (403): Forbidden: bot was blocked by the user",
    });
    expect(unreachable).toEqual({
      _tag: "TypingNotShown",
      reason: "Telegram could not be reached",
    });
  });
});

const reactWith = (
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) =>
  Effect.runPromise(
    Channel.pipe(
      Effect.flatMap((channel) =>
        channel.react({
          conversationId: "1",
          channelMessageId: "42",
          emoji: "🔥",
        })
      ),
      Effect.provide(
        telegramChannel({
          apiUrl: "https://telegram.fake",
          botToken: "token",
          fetch,
        })
      )
    )
  );

describe("Telegram reaction", () => {
  it("sets the emoji reaction on the message with setMessageReaction", async () => {
    const requests: { url: string; body: unknown }[] = [];

    const delivery = await reactWith(async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.json() });
      return Response.json({ ok: true, result: true });
    });

    expect(delivery).toEqual({ _tag: "Confirmed", channelMessageId: "42" });
    expect(requests).toEqual([
      {
        url: "https://telegram.fake/bottoken/setMessageReaction",
        body: {
          chat_id: 1,
          message_id: 42,
          reaction: [{ type: "emoji", emoji: "🔥" }],
        },
      },
    ]);
  });

  it("fails with the reason when Telegram refuses or cannot be reached", async () => {
    const refused = await reactWith(() =>
      Promise.resolve(
        Response.json(
          { ok: false, description: "Bad Request: REACTION_INVALID" },
          { status: 400 }
        )
      )
    );
    const unreachable = await reactWith(() =>
      Promise.reject(new TypeError("offline"))
    );

    expect(refused).toEqual({
      _tag: "Failed",
      reason:
        "Telegram refused the reaction (400): Bad Request: REACTION_INVALID",
    });
    expect(unreachable).toEqual({
      _tag: "Failed",
      reason: "Telegram could not be reached",
    });
  });
});

describe("Telegram reaction list", () => {
  it("keeps an allowed emoji and drops variation selectors and skin tones", () => {
    expect(telegramReactionFor("🔥")).toBe("🔥");
    expect(telegramReactionFor("✍️")).toBe("✍");
    expect(telegramReactionFor("❤️")).toBe("❤");
    expect(telegramReactionFor("👍🏽")).toBe("👍");
  });

  it("replaces an emoji that is not allowed with a close match, or gives nothing", () => {
    expect(telegramReactionFor("✅")).toBe("👌");
    expect(telegramReactionFor("😂")).toBe("🤣");
    expect(telegramReactionFor("🦖")).toBeUndefined();
    expect(telegramReactionFor("not an emoji")).toBeUndefined();
  });

  it("maps every close match to an allowed reaction", () => {
    for (const [emoji, match] of telegramCloseMatches) {
      expect(telegramReactions.has(emoji)).toBe(false);
      expect(telegramReactions.has(match)).toBe(true);
    }
  });
});
