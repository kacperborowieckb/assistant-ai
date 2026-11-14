import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JournalRecord } from "../src/journal/journal.ts";
import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { unconfirmedSendReason } from "../src/personal-agent/turn.ts";
import { fakeReplyPrefix, fakeTelegram, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Inbox | Journal>
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) => instance.runtime.runPromise(effect)
  );

const journalTags = (ownerId: string) =>
  inPersonalAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record._tag))
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

const interruptedAfter = async (
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
          channelMessageId: "61",
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

describe("Exactly one reply", () => {
  it("gives no second reply when Telegram sends the same update again", async () => {
    const ownerId = await addOwner(6001);
    const update = textUpdate({ fromUserId: 6001, text: "once" });

    const first = await telegramWebhook(update);
    const second = await telegramWebhook(update);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await vi.waitFor(async () =>
      expect(await stateOfOnlyEvent(ownerId)).toBe("done")
    );
    const third = await telegramWebhook(update);

    expect([first.status, second.status, third.status]).toEqual([
      200, 200, 200,
    ]);
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "ReplyPlanned",
      "SendStarted",
      "ReplySent",
    ]);
  });

  it("replies once to an Event whose Turn stopped before the reply was planned", async () => {
    const ownerId = await addOwner(6002);

    await interruptedAfter(ownerId, 6002, () => []);

    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      `${fakeReplyPrefix}interrupted`,
    ]);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "ReplyPlanned",
      "SendStarted",
      "ReplySent",
    ]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("done");
  });

  it("replies once to an Event whose reply was planned but whose send never started", async () => {
    const ownerId = await addOwner(6005);

    await interruptedAfter(ownerId, 6005, (eventId) => [
      { _tag: "ReplyPlanned", eventId, text: "planned only" },
    ]);

    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await stateOfOnlyEvent(ownerId)).toBe("done");
  });

  it("sends nothing after a confirmed send and only marks the Event done", async () => {
    const ownerId = await addOwner(6003);

    await interruptedAfter(ownerId, 6003, (eventId) => [
      { _tag: "ReplyPlanned", eventId, text: "already sent" },
      { _tag: "SendStarted", eventId },
      { _tag: "ReplySent", eventId, channelMessageId: "9100" },
    ]);

    expect(fakeTelegram.sent).toEqual([]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("done");
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "ReplyPlanned",
      "SendStarted",
      "ReplySent",
    ]);
  });

  it("does not send again when a send started and Telegram did not confirm it", async () => {
    const ownerId = await addOwner(6004);

    await interruptedAfter(ownerId, 6004, (eventId) => [
      { _tag: "ReplyPlanned", eventId, text: "maybe sent" },
      { _tag: "SendStarted", eventId },
    ]);

    expect(fakeTelegram.sent).toEqual([]);
    const entries = await inPersonalAgent(
      ownerId,
      Journal.pipe(Effect.flatMap((journal) => journal.read))
    );
    expect(entries.map((entry) => entry.record)).toEqual([
      expect.objectContaining({ _tag: "EventReceived" }),
      expect.objectContaining({ _tag: "ReplyPlanned" }),
      expect.objectContaining({ _tag: "SendStarted" }),
      expect.objectContaining({
        _tag: "ReplyFailed",
        reason: unconfirmedSendReason,
      }),
    ]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("failed");
  });

  it("sends once and never again when Telegram may have accepted the message but the confirmation was lost", async () => {
    const ownerId = await addOwner(6006);
    fakeTelegram.answerWith("lose-confirmation");

    await telegramWebhook(textUpdate({ fromUserId: 6006, text: "lost" }));
    await vi.waitFor(async () =>
      expect(await stateOfOnlyEvent(ownerId)).toBe("failed")
    );
    fakeTelegram.answerWith("confirm");
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    await runInDurableObject(agent, (instance) => instance.runTurn());

    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "ReplyPlanned",
      "SendStarted",
      "ReplyFailed",
    ]);
  });
});
