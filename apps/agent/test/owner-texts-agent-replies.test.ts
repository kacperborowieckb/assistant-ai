import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  fakeModel,
  fakeReplyPrefix,
  fakeTelegram,
  holdModel,
  resetFakes,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const personalAgentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inPersonalAgent = async <A>(
  ownerId: string,
  effect: Effect.Effect<A, never, Inbox | Journal | UsageLedger>
) =>
  runInDurableObject(await personalAgentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const journalOf = (ownerId: string) =>
  inPersonalAgent(
    ownerId,
    Journal.pipe(Effect.flatMap((journal) => journal.read))
  );

beforeEach(() => {
  resetFakes();
});

describe("Owner texts, agent replies", () => {
  it("stores the message before the webhook answers and replies once from the alarm", async () => {
    const ownerId = await addOwner(5001);
    const releaseModel = holdModel();

    const response = await telegramWebhook(
      textUpdate({ fromUserId: 5001, text: "hello agent", messageId: 31 })
    );

    expect(response.status).toBe(200);
    const pending = await inPersonalAgent(
      ownerId,
      Inbox.pipe(Effect.flatMap((inbox) => inbox.pending))
    );
    expect(pending.map((event) => event.text)).toEqual(["hello agent"]);
    expect(fakeTelegram.sent).toEqual([]);

    releaseModel();
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));

    expect(fakeTelegram.sent[0]?.body).toEqual({
      chat_id: 5001,
      text: `${fakeReplyPrefix}hello agent`,
      reply_parameters: { message_id: 31, allow_sending_without_reply: true },
    });
    expect(fakeTelegram.sent[0]?.url).toBe(
      `https://telegram.fake/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`
    );
    await vi.waitFor(async () =>
      expect(
        await inPersonalAgent(
          ownerId,
          Inbox.pipe(Effect.flatMap((inbox) => inbox.pending))
        )
      ).toEqual([])
    );
    expect(fakeTelegram.sent).toHaveLength(1);
  });

  it("sends the static system prompt first, then the conversation, then the new message", async () => {
    const ownerId = await addOwner(5002);

    await telegramWebhook(textUpdate({ fromUserId: 5002, text: "first" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await telegramWebhook(textUpdate({ fromUserId: 5002, text: "second" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    const secondPrompt = fakeModel.doGenerateCalls[1]?.prompt ?? [];
    expect(secondPrompt.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(secondPrompt[0]).toEqual(fakeModel.doGenerateCalls[0]?.prompt[0]);
    expect(await journalOf(ownerId)).toHaveLength(6);
  });

  it("records the Turn in the Journal and its Usage for the Owner", async () => {
    const ownerId = await addOwner(5003);

    await telegramWebhook(textUpdate({ fromUserId: 5003, text: "note this" }));
    await vi.waitFor(async () =>
      expect(await journalOf(ownerId)).toHaveLength(3)
    );

    const journal = await journalOf(ownerId);
    expect(journal.map((entry) => entry.record._tag)).toEqual([
      "EventReceived",
      "ReplyPlanned",
      "ReplySent",
    ]);
    expect(new Set(journal.map((entry) => entry.ownerId))).toEqual(
      new Set([ownerId])
    );
    expect(journal[2]?.record).toMatchObject({
      channelMessageId: "9001",
      eventId: journal[0]?.record.eventId,
    });
    expect(
      await inPersonalAgent(
        ownerId,
        UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read))
      )
    ).toEqual([
      {
        ownerId,
        task: "reply",
        modelId: "fake-reply-model",
        inputTokens: 42,
        outputTokens: 7,
        cachedInputTokens: 12,
        costUsd: null,
      },
    ]);
  });

  it("records a reply as sent only after Telegram confirms it", async () => {
    const ownerId = await addOwner(5004);
    fakeTelegram.answerWith("refuse");

    await telegramWebhook(textUpdate({ fromUserId: 5004, text: "hi" }));
    await vi.waitFor(async () =>
      expect(await journalOf(ownerId)).toHaveLength(3)
    );

    const journal = await journalOf(ownerId);
    expect(journal.map((entry) => entry.record._tag)).toEqual([
      "EventReceived",
      "ReplyPlanned",
      "ReplyFailed",
    ]);
    expect(journal[2]?.record).toMatchObject({
      reason: "Telegram refused the message (400): Bad Request: chat not found",
    });
  });
});

describe("Journal", () => {
  it("refuses updates and deletes in storage, and keeps entries across Turns", async () => {
    const ownerId = await addOwner(5005);
    await telegramWebhook(textUpdate({ fromUserId: 5005, text: "keep" }));
    await vi.waitFor(async () =>
      expect(await journalOf(ownerId)).toHaveLength(3)
    );
    const firstTurn = await journalOf(ownerId);

    await runInDurableObject(await personalAgentOf(ownerId), (_, state) => {
      expect(() =>
        state.storage.sql.exec("UPDATE journal_entries SET kind = 'edited'")
      ).toThrow("The Journal is append-only");
      expect(() =>
        state.storage.sql.exec("DELETE FROM journal_entries")
      ).toThrow("The Journal is append-only");
    });
    await telegramWebhook(textUpdate({ fromUserId: 5005, text: "again" }));
    await vi.waitFor(async () =>
      expect(await journalOf(ownerId)).toHaveLength(6)
    );

    const afterSecondTurn = await journalOf(ownerId);
    expect(afterSecondTurn.slice(0, 3)).toEqual(firstTurn);
  });
});
