import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import type { JournalRecord } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { honestFailureText } from "../src/personal-agent/turn.ts";
import {
  failModel,
  fakeModel,
  fakeReplyPrefix,
  fakeTelegram,
  resetFakes,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Journal>
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) => instance.runtime.runPromise(effect)
  );

const journalRecords = (ownerId: string) =>
  inPersonalAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record))
    )
  );

const stateOfOnlyEvent = async (ownerId: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (_, state) =>
      state.storage.sql
        .exec<{ state: string }>("SELECT state FROM inbox_events")
        .one().state
  );

const interruptedWith = async (
  ownerId: string,
  telegramUserId: number,
  records: (eventId: string) => readonly JournalRecord[]
) => {
  const agent = await personalAgentFor(
    env.PERSONAL_AGENT,
    OwnerIdSchema.make(ownerId)
  );
  await runInDurableObject(agent, async (instance) => {
    await instance.runtime.runPromise(
      Effect.gen(function* seedEffect() {
        const inbox = yield* Inbox;
        const journal = yield* Journal;
        yield* inbox.store({
          channel: "telegram",
          channelUpdateId: "interrupted-1",
          conversationId: String(telegramUserId),
          channelMessageId: "71",
          text: "interrupted",
          sentAt: new Date().toISOString(),
        });
        const [event] = yield* inbox.pending;
        for (const record of records(event?.eventId ?? "")) {
          yield* journal.append(record);
        }
      })
    );
    await instance.schedule(0, "runTurn");
  });
  await vi.waitFor(async () =>
    expect(await stateOfOnlyEvent(ownerId)).not.toBe("pending")
  );
};

beforeEach(() => {
  resetFakes();
});

describe("Honest failures", () => {
  it("sends one honest message and records the failed Turn with its reason after the model fails 3 times", async () => {
    const ownerId = await addOwner(7001);
    failModel(3);

    await telegramWebhook(textUpdate({ fromUserId: 7001, text: "hello" }));
    await vi.waitFor(
      async () => expect(await stateOfOnlyEvent(ownerId)).toBe("failed"),
      { timeout: 10_000 }
    );

    expect(fakeModel.doGenerateCalls).toHaveLength(3);
    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      honestFailureText,
    ]);
    const records = await journalRecords(ownerId);
    expect(records.map((record) => record._tag)).toEqual([
      "EventReceived",
      "TurnFailed",
      "ReplyPlanned",
      "SendStarted",
      "ReplySent",
    ]);
    expect(records[1]).toMatchObject({
      reason: expect.stringContaining("The model failed 3 times"),
    });
  });

  it("answers normally when the model fails fewer than 3 times", async () => {
    const ownerId = await addOwner(7002);
    failModel(2);

    await telegramWebhook(textUpdate({ fromUserId: 7002, text: "retry" }));
    await vi.waitFor(
      async () => expect(await stateOfOnlyEvent(ownerId)).toBe("done"),
      { timeout: 10_000 }
    );

    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      `${fakeReplyPrefix}retry`,
    ]);
  });

  it("sends the honest message once and never records it as sent when Telegram does not confirm it", async () => {
    const ownerId = await addOwner(7003);
    failModel(3);
    fakeTelegram.answerWith("refuse");

    await telegramWebhook(textUpdate({ fromUserId: 7003, text: "refused" }));
    await vi.waitFor(
      async () => expect(await stateOfOnlyEvent(ownerId)).toBe("failed"),
      { timeout: 10_000 }
    );

    expect(fakeTelegram.sent).toHaveLength(1);
    const records = await journalRecords(ownerId);
    expect(records.map((record) => record._tag)).toEqual([
      "EventReceived",
      "TurnFailed",
      "ReplyPlanned",
      "SendStarted",
      "ReplyFailed",
    ]);
  });

  it("keeps the Event failed when the Turn stopped after the honest message was confirmed", async () => {
    const ownerId = await addOwner(7005);

    await interruptedWith(ownerId, 7005, (eventId) => [
      {
        _tag: "TurnFailed",
        eventId,
        reason: "The model failed 3 times: earlier",
      },
      { _tag: "ReplyPlanned", eventId, text: honestFailureText },
      { _tag: "SendStarted", eventId },
      { _tag: "ReplySent", eventId, channelMessageId: "9100" },
    ]);

    expect(fakeTelegram.sent).toEqual([]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("failed");
  });

  it("sends the honest message once when the Turn stopped after recording the failure", async () => {
    const ownerId = await addOwner(7004);

    await interruptedWith(ownerId, 7004, (eventId) => [
      {
        _tag: "TurnFailed",
        eventId,
        reason: "The model failed 3 times: earlier",
      },
    ]);

    expect(fakeModel.doGenerateCalls).toHaveLength(0);
    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      honestFailureText,
    ]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("failed");
  });

  it("records a failed Turn with the reason when Telegram refuses a normal reply", async () => {
    const ownerId = await addOwner(7006);
    fakeTelegram.answerWith("refuse");

    await telegramWebhook(textUpdate({ fromUserId: 7006, text: "refused" }));
    await vi.waitFor(async () =>
      expect(await stateOfOnlyEvent(ownerId)).toBe("failed")
    );

    const records = await journalRecords(ownerId);
    expect(records.at(-1)).toMatchObject({
      _tag: "TurnFailed",
      reason: expect.stringContaining("Telegram refused"),
    });
  });
});
