import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "../src/event.ts";
import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { noOwnerConversationReason } from "../src/personal-agent/delivery.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import type { StoreResult } from "../src/personal-agent/inbox.ts";
import { OwnerChannelConversation } from "../src/personal-agent/owner-channel-conversation.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { fakeTelegram, holdModel, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const scheduleFired = (scheduleId: string, dueAt: string): Event => ({
  _tag: "ScheduleFired",
  scheduleId,
  dueAt,
});

const ownerMessage = (updateId: string, text: string): Event => ({
  _tag: "OwnerMessage",
  channel: "telegram",
  channelUpdateId: updateId,
  conversationId: "8001",
  channelMessageId: updateId,
  text,
  sentAt: "2026-11-15T10:00:00.000Z",
});

// The Durable Object reads the real clock, so a fixed due time turns late once
// the grace period has passed. Due now, it stays on time for the whole test run.
const reminderDueAt = DateTime.formatIso(DateTime.nowUnsafe());

const setReminder = (text: string) =>
  Schedules.pipe(
    Effect.flatMap((schedules) =>
      schedules.set({
        action: { _tag: "SendText", text },
        setBy: "owner",
        dueAt: DateTime.makeUnsafe(reminderDueAt),
        sourceEventId: "test-source",
      })
    ),
    Effect.map(({ schedule }) => schedule.scheduleId)
  );

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Inbox | OwnerChannelConversation | Schedules>
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) => instance.runtime.runPromise(effect)
  );

const storeAll = Effect.fnUntraced(function* storeAll(
  events: readonly Event[]
) {
  const inbox = yield* Inbox;
  const results: StoreResult[] = [];
  for (const event of events) {
    results.push(yield* inbox.store(event));
  }
  return results;
});

beforeEach(() => {
  resetFakes();
});

describe("ScheduleFired Event", () => {
  it("keeps one Inbox Event for the same Schedule id and due instant", async () => {
    const ownerId = "owner-schedule-duplicate";

    const results = await inPersonalAgent(
      ownerId,
      Effect.gen(function* duplicateEffect() {
        const inbox = yield* Inbox;
        const stored = yield* storeAll([
          scheduleFired("schedule-1", reminderDueAt),
          scheduleFired("schedule-1", reminderDueAt),
          scheduleFired("schedule-1", "2026-11-26T08:00:00.000Z"),
        ]);
        return { stored, pending: yield* inbox.pending };
      })
    );

    expect(results.stored).toEqual(["stored", "duplicate", "stored"]);
    expect(results.pending.map((event) => event._tag)).toEqual([
      "ScheduleFired",
      "ScheduleFired",
    ]);
  });

  it("hands pending Owner messages to the Turn before a pending ScheduleFired Event", async () => {
    const pending = await inPersonalAgent(
      "owner-schedule-order",
      Effect.gen(function* orderEffect() {
        const inbox = yield* Inbox;
        yield* storeAll([
          scheduleFired("schedule-2", "2026-11-19T08:00:00.000Z"),
          ownerMessage("1", "first owner message"),
          scheduleFired("schedule-3", "2026-11-19T09:00:00.000Z"),
          ownerMessage("2", "second owner message"),
        ]);
        return yield* inbox.pending;
      })
    );

    expect(
      pending.map((event) =>
        event._tag === "OwnerMessage" ? event.text : event.scheduleId
      )
    ).toEqual([
      "first owner message",
      "second owner message",
      "schedule-2",
      "schedule-3",
    ]);
  });
});

describe("Owner Channel Conversation", () => {
  it("is empty before the Owner writes and kept after an Owner message", async () => {
    const ownerId = await addOwner(8002);
    const read = OwnerChannelConversation.pipe(
      Effect.flatMap((conversation) => conversation.current)
    );
    expect(await inPersonalAgent(ownerId, read)).toBeUndefined();
    const releaseModel = holdModel();

    await telegramWebhook(textUpdate({ fromUserId: 8002, text: "hello" }));

    expect(await inPersonalAgent(ownerId, read)).toEqual({
      channel: "telegram",
      conversationId: "8002",
    });
    releaseModel();
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  });

  it("sends a Turn of a ScheduleFired Event to the Owner without a message to reply to", async () => {
    const ownerId = await addOwner(8003);
    await telegramWebhook(textUpdate({ fromUserId: 8003, text: "hello" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));

    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    const scheduleId = await inPersonalAgent(
      ownerId,
      setReminder("buy the gift")
    );
    await agent.receive(scheduleFired(scheduleId, reminderDueAt));

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(fakeTelegram.sent[1]?.body.text).toBe("buy the gift");
    expect(fakeTelegram.sent[1]?.body.chat_id).toBe(8003);
    expect(fakeTelegram.sent[1]?.body.reply_parameters).toBeUndefined();
  });

  it("fails the Turn of a ScheduleFired Event when the Owner has not written yet", async () => {
    const ownerId = "owner-never-wrote";
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    const scheduleId = await inPersonalAgent(ownerId, setReminder("call Ana"));
    await agent.receive(scheduleFired(scheduleId, reminderDueAt));

    await vi.waitFor(async () => {
      const pending = await inPersonalAgent(
        ownerId,
        Inbox.pipe(Effect.flatMap((inbox) => inbox.pending))
      );
      expect(pending).toHaveLength(0);
    });
    expect(fakeTelegram.sent).toEqual([]);
  });

  it("sends no apology for a ScheduleFired Event whose failed delivery was already recorded", async () => {
    const ownerId = await addOwner(8004);
    await telegramWebhook(textUpdate({ fromUserId: 8004, text: "hello" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );

    await runInDurableObject(agent, async (instance) => {
      await instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const inbox = yield* Inbox;
          const journal = yield* Journal;
          yield* inbox.store(
            scheduleFired(yield* setReminder("x"), reminderDueAt)
          );
          const pending = yield* inbox.pending;
          const eventId = pending[0]?.eventId ?? "";
          yield* journal.append({ _tag: "ReplyPlanned", eventId, text: "x" });
          yield* journal.append({
            _tag: "ReplyFailed",
            eventId,
            reason: noOwnerConversationReason,
          });
          yield* journal.append({
            _tag: "TurnFailed",
            eventId,
            reason: noOwnerConversationReason,
          });
        })
      );
      await instance.schedule(0, "runTurn");
    });

    await vi.waitFor(async () => {
      const pending = await inPersonalAgent(
        ownerId,
        Inbox.pipe(Effect.flatMap((inbox) => inbox.pending))
      );
      expect(pending).toHaveLength(0);
    });
    expect(fakeTelegram.sent).toHaveLength(1);
  });
});
