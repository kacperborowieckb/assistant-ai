import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JournalRecord } from "../src/journal/journal.ts";
import { Journal } from "../src/journal/journal.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Conversation } from "../src/personal-agent/conversation.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  reactToolName,
  reactionAfterFailureMessage,
} from "../src/personal-agent/react-tool.ts";
import {
  silenceAfterChangeMessage,
  staySilentToolName,
} from "../src/personal-agent/stay-silent-tool.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  fakeBursts,
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  fakeTool,
  resetFakes,
  scriptModel,
  testTypingRepeatMillis,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Conversation | Inbox | Journal | TurnTraces>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const eventStates = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM inbox_events ORDER BY sequence"
      )
      .toArray()
      .map((row) => row.state)
  );

const journalRecords = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record))
    )
  );

const journalTags = async (ownerId: string) => {
  const records = await journalRecords(ownerId);
  return records.map((record) => record._tag);
};

const replyTraceOf = async (ownerId: string) => {
  const traces = await inAgent(
    ownerId,
    TurnTraces.pipe(Effect.flatMap((turnTraces) => turnTraces.readReplies))
  );
  expect(traces).toHaveLength(1);
  return traces[0]?.trace;
};

const turnMetricBlobs = () =>
  fakeMetrics.dataPoints
    .filter((point) => point.blobs?.[0] === "turn")
    .map((point) => point.blobs);

const toolResultTexts = () =>
  fakeModel.doGenerateCalls.flatMap((call) =>
    call.prompt.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" && part.output.type === "text"
              ? [part.output.value]
              : []
          )
        : []
    )
  );

const ownerSays = async (telegramUserId: number, text: string) => {
  const ownerId = await addOwner(telegramUserId);
  await telegramWebhook(
    textUpdate({ fromUserId: telegramUserId, text, messageId: 77 })
  );
  await vi.waitFor(
    async () => expect(await eventStates(ownerId)).not.toEqual(["pending"]),
    { timeout: 10_000 }
  );
  return ownerId;
};

const reactWith = (emoji: string) =>
  ({ callTool: reactToolName, input: { emoji } }) as const;

interface StoredMessages {
  readonly ownerId: string;
  readonly telegramUserId: number;
  readonly texts: readonly string[];
  readonly records?: (eventIds: readonly string[]) => readonly JournalRecord[];
}

const storeOwnerMessages = ({
  ownerId,
  telegramUserId,
  texts,
  records = () => [],
}: StoredMessages) =>
  inAgent(
    ownerId,
    Effect.gen(function* storeEffect() {
      const inbox = yield* Inbox;
      const journal = yield* Journal;
      for (const [index, text] of texts.entries()) {
        yield* inbox.store({
          _tag: "OwnerMessage",
          channel: "telegram",
          channelUpdateId: `reaction-${index}`,
          conversationId: String(telegramUserId),
          channelMessageId: String(91 + index),
          text,
          sentAt: new Date().toISOString(),
        });
      }
      const eventIds = (yield* inbox.pending).map((event) => event.eventId);
      for (const record of records(eventIds)) {
        yield* journal.append(record);
      }
    })
  );

const runTurn = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) => instance.runTurn());

beforeEach(() => {
  resetFakes();
});

describe("One outcome for each Event: a reaction", () => {
  it("reacts with an allowed emoji on the Owner message, sends no text, and shows no typing after the reaction", async () => {
    fakeTelegram.delaySendsBy(4 * testTypingRepeatMillis);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy milk" } },
      reactWith("✍"),
    ]);

    const ownerId = await ownerSays(6201, "buy milk");

    expect(fakeTelegram.sent).toEqual([]);
    expect(fakeTelegram.reactions).toMatchObject([
      { chatId: 6201, messageId: 77, emoji: "✍" },
    ]);
    const [reaction] = fakeTelegram.reactions;
    expect(reaction?.chatActionsBefore).toBeGreaterThan(0);
    await scheduler.wait(3 * testTypingRepeatMillis);
    expect(fakeTelegram.chatActions).toHaveLength(
      reaction?.chatActionsBefore ?? -1
    );
    expect(await eventStates(ownerId)).toEqual(["done"]);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "NoteCaptured",
      "ReactionPlanned",
      "SendStarted",
      "ReplySent",
    ]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({ kind: "reaction", emoji: "✍" });
    expect(trace?.refusedOutcomeTools).toEqual([]);
    expect(turnMetricBlobs()).toEqual([
      [
        "turn",
        "reacted",
        "fake-reply-model",
        "cost_unknown",
        trace?.eventId,
        "reaction",
      ],
    ]);
    const history = await inAgent(
      ownerId,
      Conversation.pipe(Effect.flatMap((conversation) => conversation.recent))
    );
    expect(JSON.stringify(history)).toContain("buy milk");
    expect(JSON.stringify(history)).toContain('"emoji":"✍"');
  });

  it("replaces an emoji that Telegram does not allow with a close match, and the Trace records it", async () => {
    scriptModel([reactWith("✅")]);

    const ownerId = await ownerSays(6202, "done with the report");

    expect(fakeTelegram.reactions.map((reaction) => reaction.emoji)).toEqual([
      "👌",
    ]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({
      kind: "reaction",
      emoji: "👌",
      requestedEmoji: "✅",
    });
    expect(trace?.steps.at(-1)?.toolCalls).toMatchObject([
      { name: reactToolName, output: '{"outcome":"reaction","emoji":"👌"}' },
    ]);
  });

  it("replaces an emoji with no close match with the default reaction", async () => {
    scriptModel([reactWith("🦖")]);

    const ownerId = await ownerSays(6203, "dinosaurs are cool");

    expect(fakeTelegram.reactions.map((reaction) => reaction.emoji)).toEqual([
      "👍",
    ]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({
      kind: "reaction",
      emoji: "👍",
      requestedEmoji: "🦖",
    });
  });

  it("keeps an allowed emoji sent with a variation selector", async () => {
    scriptModel([reactWith("❤️‍🔥")]);

    await ownerSays(6204, "I love it");

    expect(fakeTelegram.reactions.map((reaction) => reaction.emoji)).toEqual([
      "❤‍🔥",
    ]);
  });

  it("reacts on the newest Owner message of a burst", async () => {
    const ownerId = await addOwner(6205);
    await storeOwnerMessages({
      ownerId,
      telegramUserId: 6205,
      texts: ["buy milk", "and eggs", "and bread"],
    });
    fakeBursts.allPendingTogether = true;
    scriptModel([reactWith("✍")]);

    await runTurn(ownerId);

    expect(fakeTelegram.sent).toEqual([]);
    expect(fakeTelegram.reactions).toMatchObject([
      { chatId: 6205, messageId: 93, emoji: "✍" },
    ]);
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
  });

  it("sends an unconfirmed reaction again after a reset, with no model call and no text", async () => {
    const ownerId = await addOwner(6206);
    await storeOwnerMessages({
      ownerId,
      telegramUserId: 6206,
      texts: ["buy milk"],
      records: ([eventId = ""]) => [
        { _tag: "ReactionPlanned", eventId, emoji: "✍" },
        { _tag: "SendStarted", eventId },
      ],
    });

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toEqual([]);
    expect(fakeTelegram.sent).toEqual([]);
    expect(fakeTelegram.reactions).toMatchObject([
      { chatId: 6206, messageId: 91, emoji: "✍" },
    ]);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "ReactionPlanned",
      "SendStarted",
      "SendStarted",
      "ReplySent",
    ]);
    expect(await eventStates(ownerId)).toEqual(["done"]);

    await runTurn(ownerId);

    expect(fakeTelegram.reactions).toHaveLength(1);
  });

  it("marks the Event failed when the reaction sent again after a reset is refused", async () => {
    const ownerId = await addOwner(6207);
    await storeOwnerMessages({
      ownerId,
      telegramUserId: 6207,
      texts: ["buy milk"],
      records: ([eventId = ""]) => [
        { _tag: "ReactionPlanned", eventId, emoji: "✍" },
        { _tag: "SendStarted", eventId },
      ],
    });
    fakeTelegram.answerWith("refuse");

    await runTurn(ownerId);

    expect(fakeTelegram.sent).toEqual([]);
    expect(fakeTelegram.reactions).toHaveLength(1);
    expect(await eventStates(ownerId)).toEqual(["failed"]);
    const tags = await journalTags(ownerId);
    expect(tags.slice(-2)).toEqual(["ReplyFailed", "TurnFailed"]);
  });

  it("refuses a reaction after a changing tool call failed, and the model answers with text", async () => {
    fakeTool.failWith = "The store is down";
    scriptModel([
      { callTool: fakeTool.name, input: { word: "milk" } },
      reactWith("✍"),
      { say: "Sorry, I could not keep that." },
    ]);

    const ownerId = await ownerSays(6208, "keep milk");

    expect(fakeTelegram.reactions).toMatchObject([]);
    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      "Sorry, I could not keep that.",
    ]);
    expect(toolResultTexts()).toEqual([reactionAfterFailureMessage]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({ kind: "reply" });
    expect(trace?.refusedOutcomeTools).toEqual([reactToolName]);
  });

  it("sends the default reaction when a Turn that changed Owner data ends with no outcome after a refused silence", async () => {
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy milk" } },
      { callTool: staySilentToolName, input: {} },
      { say: "" },
    ]);

    const ownerId = await ownerSays(6209, "buy milk");

    expect(toolResultTexts()).toEqual([silenceAfterChangeMessage]);
    expect(fakeTelegram.sent).toEqual([]);
    expect(fakeTelegram.reactions).toMatchObject([
      { chatId: 6209, messageId: 77, emoji: "👍" },
    ]);
    expect(await eventStates(ownerId)).toEqual(["done"]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({ kind: "reaction", emoji: "👍" });
    expect(trace?.refusedOutcomeTools).toEqual([staySilentToolName]);
  });

  it("records the reaction outcome in the metric when Telegram refuses the reaction", async () => {
    fakeTelegram.answerWith("refuse");
    scriptModel([reactWith("🔥")]);

    const ownerId = await ownerSays(6210, "done with the report");

    expect(await eventStates(ownerId)).toEqual(["failed"]);
    expect(fakeTelegram.sent).toEqual([]);
    const [blobs] = turnMetricBlobs();
    expect(blobs?.[1]).toBe("send_failed");
    expect(blobs?.[5]).toBe("reaction");
  });
});
