import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { fakeTelegram, resetFakes } from "./fakes.ts";
import {
  addOwner,
  sendToEdge,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

const storedInOwnersAgent = async (ownerId: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Effect.all({
          events: Inbox.pipe(Effect.flatMap((inbox) => inbox.pending)),
          journal: Journal.pipe(Effect.flatMap((journal) => journal.read)),
        })
      )
  );

const countRows = async (table: "owners" | "channel_identities") => {
  const row = await env.DIRECTORY.prepare(
    `SELECT COUNT(*) AS total FROM ${table}`
  ).first<{ total: number }>();
  return row?.total;
};

const suspend = (ownerId: string) =>
  env.DIRECTORY.prepare(
    "UPDATE owners SET status = 'suspended' WHERE owner_id = ?"
  )
    .bind(ownerId)
    .run();

const settle = () => scheduler.wait(200);

beforeEach(() => {
  resetFakes();
});

describe("Only the Owner gets through", () => {
  it.each([
    ["no secret token", 7001, null],
    ["a wrong secret token", 7002, "not-the-secret"],
    ["a secret token of another length", 7003, "x"],
  ])(
    "answers 401 and stores nothing for %s",
    async (_, telegramUserId, secret) => {
      const ownerId = await addOwner(telegramUserId);

      const response = await telegramWebhook(
        textUpdate({ fromUserId: telegramUserId, text: "let me in" }),
        secret
      );

      expect(response.status).toBe(401);
      expect(await storedInOwnersAgent(ownerId)).toEqual({
        events: [],
        journal: [],
      });
      await settle();
      expect(fakeTelegram.sent).toEqual([]);
    }
  );

  it("answers 200 with no reply and no kept content for an unknown sender", async () => {
    const ownersBefore = await countRows("owners");
    const identitiesBefore = await countRows("channel_identities");

    const response = await telegramWebhook(
      textUpdate({ fromUserId: 7022, text: "who are you" })
    );

    expect(response.status).toBe(200);
    await settle();
    expect(fakeTelegram.sent).toEqual([]);
    expect(await countRows("owners")).toBe(ownersBefore);
    expect(await countRows("channel_identities")).toBe(identitiesBefore);
  });

  it("answers 200 with no reply and no kept content for an Owner who is not active", async () => {
    const ownerId = await addOwner(7023);
    await suspend(ownerId);

    const response = await telegramWebhook(
      textUpdate({ fromUserId: 7023, text: "am I still here" })
    );

    expect(response.status).toBe(200);
    await settle();
    expect(fakeTelegram.sent).toEqual([]);
    expect(await storedInOwnersAgent(ownerId)).toEqual({
      events: [],
      journal: [],
    });
  });

  it.each([
    [
      "a sticker",
      7011,
      (fromUserId: number) => ({
        update_id: 99_000,
        message: {
          message_id: 5,
          date: 1_794_000_000,
          chat: { id: fromUserId, type: "private" },
          from: { id: fromUserId, is_bot: false },
          sticker: { file_id: "abc" },
        },
      }),
    ],
    [
      "an edited message",
      7012,
      (fromUserId: number) => ({
        update_id: 99_001,
        edited_message: textUpdate({ fromUserId, text: "edit" }).message,
      }),
    ],
    [
      "a text in a group chat",
      7013,
      (fromUserId: number) => {
        const update = textUpdate({ fromUserId, text: "group" });
        return {
          ...update,
          message: { ...update.message, chat: { id: -1, type: "group" } },
        };
      },
    ],
    ["a body that is not an update", 7014, () => ({ hello: "world" })],
  ])(
    "answers 200 and ignores %s from the Owner",
    async (_, telegramUserId, makeUpdate) => {
      const ownerId = await addOwner(telegramUserId);

      const response = await telegramWebhook(makeUpdate(telegramUserId));

      expect(response.status).toBe(200);
      await settle();
      expect(fakeTelegram.sent).toEqual([]);
      expect(await storedInOwnersAgent(ownerId)).toEqual({
        events: [],
        journal: [],
      });
    }
  );

  it("answers 200 and ignores a request body that is not JSON", async () => {
    const response = await sendToEdge(
      new Request("https://agent.test/telegram/webhook", {
        method: "POST",
        headers: {
          "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: "not json",
      })
    );

    expect(response.status).toBe(200);
  });
});
