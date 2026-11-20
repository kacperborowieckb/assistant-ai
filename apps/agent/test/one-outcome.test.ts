import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JournalRecord } from "../src/journal/journal.ts";
import { Journal } from "../src/journal/journal.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { searchNotesToolName } from "../src/notes/search-notes-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import {
  honestFailureText,
  unconfirmedSendReason,
} from "../src/personal-agent/delivery.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  silenceAfterChangeMessage,
  silenceAfterFailureMessage,
  staySilentToolName,
} from "../src/personal-agent/stay-silent-tool.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  failModel,
  fakeMetrics,
  fakeModel,
  fakeReplyPrefix,
  fakeTelegram,
  fakeTool,
  holdModel,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Inbox | Journal | TurnTraces>
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
          _tag: "OwnerMessage",
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

describe("One outcome for each Event: a reply", () => {
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
      expect.objectContaining({
        _tag: "TurnFailed",
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
      "TurnFailed",
    ]);
  });

  it("replies once after the Durable Object is reset in the middle of a Turn", async () => {
    const ownerId = await addOwner(6007);
    const releaseModel = holdModel();

    await telegramWebhook(textUpdate({ fromUserId: 6007, text: "interrupt" }));
    await vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(1));
    await abortAllDurableObjects();
    releaseModel();
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    await runDurableObjectAlarm(agent);

    await vi.waitFor(async () =>
      expect(await stateOfOnlyEvent(ownerId)).toBe("done")
    );
    expect(fakeTelegram.sent).toHaveLength(1);
  });

  it("schedules a Turn for a stranded Event when Telegram sends its update again", async () => {
    const ownerId = await addOwner(6008);
    const update = textUpdate({ fromUserId: 6008, text: "stranded" });
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Inbox.pipe(
          Effect.flatMap((inbox) =>
            inbox.store({
              _tag: "OwnerMessage",
              channel: "telegram",
              channelUpdateId: String(update.update_id),
              conversationId: "6008",
              channelMessageId: String(update.message.message_id),
              text: "stranded",
              sentAt: new Date().toISOString(),
            })
          )
        )
      )
    );
    expect(await stateOfOnlyEvent(ownerId)).toBe("pending");

    await telegramWebhook(update);

    await vi.waitFor(async () =>
      expect(await stateOfOnlyEvent(ownerId)).toBe("done")
    );
    expect(fakeTelegram.sent).toHaveLength(1);
  });
});

const staySilent = { callTool: staySilentToolName, input: {} } as const;

const replyTraceOf = async (ownerId: string) => {
  const traces = await inPersonalAgent(
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
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));
  await vi.waitFor(
    async () => expect(await stateOfOnlyEvent(ownerId)).not.toBe("pending"),
    { timeout: 10_000 }
  );
  return ownerId;
};

describe("One outcome for each Event: silence", () => {
  it("makes no Channel call for small talk and records the silent outcome", async () => {
    scriptModel([staySilent]);

    const ownerId = await ownerSays(6101, "ok");

    expect(fakeTelegram.sent).toEqual([]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("done");
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "StayedSilent",
    ]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({ kind: "silent" });
    expect(trace?.refusedOutcomeTools).toEqual([]);
    expect(trace?.steps.at(-1)?.toolCalls).toMatchObject([
      { name: staySilentToolName, failed: false },
    ]);
    expect(turnMetricBlobs()).toEqual([
      [
        "turn",
        "silent",
        "fake-reply-model",
        "cost_unknown",
        trace?.eventId,
        "silent",
      ],
    ]);
  });

  it("sends nothing later, also after the Durable Object is reset and the Turn runs again", async () => {
    scriptModel([staySilent]);
    const ownerId = await ownerSays(6102, "thanks");

    await abortAllDurableObjects();
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    await runInDurableObject(agent, (instance) => instance.runTurn());

    expect(fakeTelegram.sent).toEqual([]);
    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "StayedSilent",
    ]);
  });

  it("marks an interrupted silent Event done without sending or calling the model", async () => {
    const ownerId = await addOwner(6103);

    await interruptedAfter(ownerId, 6103, (eventId) => [
      { _tag: "StayedSilent", eventId },
    ]);

    expect(fakeTelegram.sent).toEqual([]);
    expect(fakeModel.doGenerateCalls).toEqual([]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("done");
  });

  it("refuses silence after a write tool changed Owner data, and the model answers with text", async () => {
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy milk" } },
      staySilent,
      { say: "Kept: buy milk" },
    ]);

    const ownerId = await ownerSays(6104, "buy milk");

    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      "Kept: buy milk",
    ]);
    expect(toolResultTexts()).toEqual([silenceAfterChangeMessage]);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "NoteCaptured",
      "ReplyPlanned",
      "SendStarted",
      "ReplySent",
    ]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({ kind: "reply" });
    expect(trace?.refusedOutcomeTools).toEqual([staySilentToolName]);
    expect(turnMetricBlobs()[0]?.slice(1, 2)).toEqual(["replied"]);
    expect(turnMetricBlobs()[0]?.[5]).toBe("reply");
  });

  it("refuses silence after a changing tool call failed", async () => {
    fakeTool.failWith = "The store is down";
    scriptModel([
      { callTool: fakeTool.name, input: { word: "milk" } },
      staySilent,
      { say: "Sorry, I could not keep that." },
    ]);

    await ownerSays(6105, "keep milk");

    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      "Sorry, I could not keep that.",
    ]);
    expect(toolResultTexts()).toEqual([silenceAfterFailureMessage]);
  });

  it("allows silence after a read-only tool call", async () => {
    scriptModel([
      { callTool: searchNotesToolName, input: { query: "milk" } },
      staySilent,
    ]);

    const ownerId = await ownerSays(6106, "ok then");

    expect(fakeTelegram.sent).toEqual([]);
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toEqual({ kind: "silent" });
  });

  it("still sends the honest failure text when the model call fails", async () => {
    failModel(3);

    const ownerId = await ownerSays(6107, "ok");

    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      honestFailureText,
    ]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("failed");
  });

  it("sends the honest failure text when the model fails after a refused silence", async () => {
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy milk" } },
      staySilent,
      { error: "down" },
      { error: "down" },
      { error: "down" },
    ]);

    const ownerId = await ownerSays(6108, "buy milk");

    expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual([
      honestFailureText,
    ]);
    expect(await stateOfOnlyEvent(ownerId)).toBe("failed");
    const trace = await replyTraceOf(ownerId);
    expect(trace?.outcome).toBeNull();
    expect(trace?.refusedOutcomeTools).toEqual([staySilentToolName]);
    expect(trace?.steps.flatMap((step) => step.toolCalls)).toMatchObject([
      { name: captureNoteToolName, failed: false },
      { name: staySilentToolName, failed: true },
    ]);
  });
});
