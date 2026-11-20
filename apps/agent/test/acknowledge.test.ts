import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import {
  fakeReplyPrefix,
  fakeTelegram,
  holdModel,
  resetFakes,
  scriptModel,
  testTypingRepeatMillis,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Journal | OwnerPreferences | Schedules>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const journalTagsOf = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record._tag))
    )
  );

const pause = (millis: number) => scheduler.wait(millis);

const settleTyping = async () => {
  await pause(testTypingRepeatMillis * 2);
  return fakeTelegram.chatActions.length;
};

const warsawName = "Europe/Warsaw";
const warsaw = DateTime.zoneMakeNamedUnsafe(warsawName);

const localClock = (instant: DateTime.Utc) => {
  const { hour, minute } = DateTime.toParts(DateTime.setZone(instant, warsaw));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

beforeEach(() => {
  resetFakes();
});

describe("Acknowledge: typing while the agent works", () => {
  it("shows typing within a second of the Owner message and before the model call", async () => {
    await addOwner(12_101);
    const releaseModel = holdModel();

    const sentAt = Date.now();
    await telegramWebhook(
      textUpdate({ fromUserId: 12_101, text: "hello", messageId: 41 })
    );
    await vi.waitFor(() =>
      expect(fakeTelegram.chatActionsAtModelCalls).toHaveLength(1)
    );

    const [first] = fakeTelegram.chatActions;
    expect(first).toMatchObject({ chatId: 12_101, action: "typing" });
    expect((first?.at ?? Number.POSITIVE_INFINITY) - sentAt).toBeLessThan(1000);
    expect(fakeTelegram.chatActionsAtModelCalls[0]).toBeGreaterThanOrEqual(1);
    releaseModel();
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  });

  it("repeats typing while the model is held and stops after the reply is delivered", async () => {
    const ownerId = await addOwner(12_102);
    const releaseModel = holdModel();

    await telegramWebhook(textUpdate({ fromUserId: 12_102, text: "slow one" }));
    await vi.waitFor(() =>
      expect(fakeTelegram.chatActions.length).toBeGreaterThanOrEqual(4)
    );
    expect(fakeTelegram.sent).toEqual([]);
    const gaps = fakeTelegram.chatActions
      .slice(1)
      .map(
        (action, index) =>
          action.at - (fakeTelegram.chatActions[index]?.at ?? action.at)
      );
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(testTypingRepeatMillis - 20);
    }

    releaseModel();
    await vi.waitFor(async () =>
      expect(await journalTagsOf(ownerId)).toContain("ReplySent")
    );
    const afterDelivery = await settleTyping();
    await pause(testTypingRepeatMillis * 5);

    expect(fakeTelegram.chatActions).toHaveLength(afterDelivery);
    expect(
      new Set(
        fakeTelegram.chatActions.map(
          (action) => `${action.chatId}:${action.action}`
        )
      )
    ).toEqual(new Set(["12102:typing"]));
    expect(fakeTelegram.sent).toHaveLength(1);
  });

  it("keeps the Turn's outcome when Telegram refuses the typing signal", async () => {
    const ownerId = await addOwner(12_103);
    fakeTelegram.answerChatActionsWith("refuse");

    await telegramWebhook(textUpdate({ fromUserId: 12_103, text: "refused" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));

    expect(fakeTelegram.chatActions.length).toBeGreaterThanOrEqual(1);
    expect(fakeTelegram.sent[0]?.body.text).toBe(`${fakeReplyPrefix}refused`);
    await vi.waitFor(async () =>
      expect(await journalTagsOf(ownerId)).toEqual([
        "EventReceived",
        "ReplyPlanned",
        "SendStarted",
        "ReplySent",
      ])
    );
  });

  it("does not wait for a typing signal that Telegram never answers", async () => {
    const ownerId = await addOwner(12_104);
    fakeTelegram.answerChatActionsWith("hang");

    const sentAt = Date.now();
    await telegramWebhook(textUpdate({ fromUserId: 12_104, text: "hanging" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));

    expect(Date.now() - sentAt).toBeLessThan(2000);
    expect(fakeTelegram.chatActions).toHaveLength(1);
    expect(fakeTelegram.sent[0]?.body.text).toBe(`${fakeReplyPrefix}hanging`);
    await vi.waitFor(async () =>
      expect(await journalTagsOf(ownerId)).toContain("ReplySent")
    );
  });

  it("shows no typing for a fired Reminder, Scheduled Task, or Proactive Message", async () => {
    const ownerId = await addOwner(12_105);
    scriptModel([
      { callTool: setTimeZoneToolName, input: { timeZone: warsawName } },
      { say: "Done" },
    ]);
    await telegramWebhook(
      textUpdate({ fromUserId: 12_105, text: "I live in Warsaw" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const now = DateTime.nowUnsafe();
    await inAgent(
      ownerId,
      Effect.gen(function* seedDueSchedules() {
        const preferences = yield* OwnerPreferences;
        yield* preferences.setQuietHours(
          {
            start: localClock(DateTime.add(now, { hours: 2 })),
            end: localClock(DateTime.add(now, { hours: 3 })),
          },
          { start: "22:00", end: "08:00" },
          "test-setup"
        );
        const schedules = yield* Schedules;
        const dueAt = DateTime.subtract(now, { seconds: 5 });
        yield* schedules.set({
          action: { _tag: "SendText", text: "Water the plants" },
          setBy: "owner",
          dueAt,
          sourceEventId: "setup-reminder",
        });
        yield* schedules.set({
          action: { _tag: "RunPrompt", prompt: "List my notes" },
          setBy: "owner",
          dueAt,
          sourceEventId: "setup-task",
        });
      })
    );
    const beforeFires = await settleTyping();

    await runInDurableObject(await agentOf(ownerId), (instance, state) => {
      state.storage.sql.exec(
        "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent' AND text = ?",
        DateTime.formatIso(DateTime.subtract(now, { seconds: 5 })),
        briefPrompt
      );
      return instance.fireDueSchedules();
    });
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(4));
    await pause(testTypingRepeatMillis * 3);

    expect(fakeTelegram.sent.map((sent) => sent.body.text)).toContain(
      "Water the plants"
    );
    expect(fakeTelegram.chatActions).toHaveLength(beforeFires);
  });
});
