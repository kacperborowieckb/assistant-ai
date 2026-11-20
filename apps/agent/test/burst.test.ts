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
import {
  captureNoteToolName,
  severalForwardedMessagesMessage,
} from "../src/notes/capture-note-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Conversation } from "../src/personal-agent/conversation.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { muteProactiveMessageToolName } from "../src/proactive/mute-proactive-message-tool.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  fakeBursts,
  fakeModel,
  fakeReplyPrefix,
  fakeTelegram,
  holdModel,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner } from "./telegram-requests.ts";

const burstTexts = ["first", "second", "third"] as const;

type ModelPrompt = (typeof fakeModel.doGenerateCalls)[number]["prompt"];

const ownerTextsOf = (prompt: ModelPrompt) =>
  prompt
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "text" ? [part.text] : []
      )
    );

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    Inbox | Journal | Conversation | TurnTraces | Notes | OwnerPreferences
  >
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

interface BurstSeed {
  readonly records?: (eventIds: readonly string[]) => readonly JournalRecord[];
  readonly forwarded?: readonly number[];
}

const storeBurst = (
  ownerId: string,
  telegramUserId: number,
  { records = () => [], forwarded = [] }: BurstSeed = {}
) =>
  inPersonalAgent(
    ownerId,
    Effect.gen(function* storeBurstEffect() {
      const inbox = yield* Inbox;
      const journal = yield* Journal;
      for (const [index, text] of burstTexts.entries()) {
        yield* inbox.store({
          _tag: "OwnerMessage",
          channel: "telegram",
          channelUpdateId: `burst-${index}`,
          conversationId: String(telegramUserId),
          channelMessageId: String(71 + index),
          text,
          sentAt: new Date().toISOString(),
          ...(forwarded.includes(index)
            ? { forwardOrigin: `Sender ${index}` }
            : {}),
        });
      }
      const eventIds = (yield* inbox.pending).map((event) => event.eventId);
      for (const record of records(eventIds)) {
        yield* journal.append(record);
      }
      return eventIds;
    })
  );

const markDone = async (ownerId: string, eventId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) => {
    state.storage.sql.exec(
      "UPDATE inbox_events SET state = 'done' WHERE event_id = ?",
      eventId
    );
  });

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
  inPersonalAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record))
    )
  );

const runTurn = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) => instance.runTurn());

const links = (eventIds: readonly string[]): readonly JournalRecord[] => {
  const [turnEventId = "", ...others] = eventIds;
  return others.map((eventId) => ({
    _tag: "AnsweredByTurn",
    eventId,
    turnEventId,
  }));
};

const sentDelivery = (eventIds: readonly string[]): JournalRecord[] => {
  const [turnEventId = ""] = eventIds;
  return [
    { _tag: "ReplyPlanned", eventId: turnEventId, text: "already sent" },
    { _tag: "SendStarted", eventId: turnEventId },
    { _tag: "ReplySent", eventId: turnEventId, channelMessageId: "9100" },
  ];
};

interface NoteRow extends Record<string, SqlStorageValue> {
  text: string;
  source_event_id: string;
  source_channel_message_id: string;
  trust_level: string;
}

const noteRows = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<NoteRow>(
        "SELECT text, source_event_id, source_channel_message_id, trust_level FROM notes"
      )
      .toArray()
  );

const toolResultsOf = (prompt: ModelPrompt) =>
  prompt
    .filter((message) => message.role === "tool")
    .flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "tool-result" ? [JSON.stringify(part.output)] : []
      )
    );

beforeEach(() => {
  resetFakes();
});

describe("A Turn answers a burst of Owner messages", () => {
  it("makes one model call with every message in order and one Delivery on the newest message", async () => {
    const ownerId = await addOwner(7101);
    const eventIds = await storeBurst(ownerId, 7101);
    fakeBursts.allPendingTogether = true;

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(ownerTextsOf(fakeModel.doGenerateCalls[0]?.prompt ?? [])).toEqual(
      burstTexts
    );
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(fakeTelegram.sent[0]?.body).toMatchObject({
      text: `${fakeReplyPrefix}third`,
      reply_parameters: { message_id: 73 },
    });
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
    const [turnEventId] = eventIds;
    expect(await journalRecords(ownerId)).toEqual([
      ...eventIds.map((eventId) => ({ _tag: "EventReceived", eventId })),
      ...links(eventIds),
      expect.objectContaining({ _tag: "ReplyPlanned", eventId: turnEventId }),
      { _tag: "SendStarted", eventId: turnEventId },
      expect.objectContaining({ _tag: "ReplySent", eventId: turnEventId }),
    ]);
    const { traces, conversation } = await inPersonalAgent(
      ownerId,
      Effect.all({
        traces: TurnTraces.pipe(
          Effect.flatMap((store) => store.readForEvent(turnEventId ?? ""))
        ),
        conversation: Conversation.pipe(
          Effect.flatMap((store) => store.recent)
        ),
      })
    );
    expect(traces).toHaveLength(1);
    expect(conversation.map((message) => message.content)).toEqual([
      ...burstTexts,
      expect.anything(),
    ]);
  });

  it("gives no second send and no second Turn after a reset that came after the send and before the other Events were settled", async () => {
    const ownerId = await addOwner(7102);
    const eventIds = await storeBurst(ownerId, 7102, {
      records: (ids) => [...links(ids), ...sentDelivery(ids)],
    });
    await markDone(ownerId, eventIds[0] ?? "");

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toEqual([]);
    expect(fakeTelegram.sent).toEqual([]);
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
    const records = await journalRecords(ownerId);
    expect(records.map(({ _tag }) => _tag)).toEqual([
      "EventReceived",
      "EventReceived",
      "EventReceived",
      "AnsweredByTurn",
      "AnsweredByTurn",
      "ReplyPlanned",
      "SendStarted",
      "ReplySent",
    ]);
  });

  it("settles the whole burst with no send when the reset came after the send and before the Turn Event was settled", async () => {
    const ownerId = await addOwner(7103);
    await storeBurst(ownerId, 7103, {
      records: (ids) => [...links(ids), ...sentDelivery(ids)],
    });

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toEqual([]);
    expect(fakeTelegram.sent).toEqual([]);
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
  });

  it("fails the other Events of a burst whose Delivery failed, with no send", async () => {
    const ownerId = await addOwner(7104);
    const eventIds = await storeBurst(ownerId, 7104, {
      records: (ids) => [
        ...links(ids),
        { _tag: "ReplyPlanned", eventId: ids[0] ?? "", text: "refused" },
        { _tag: "SendStarted", eventId: ids[0] ?? "" },
        { _tag: "ReplyFailed", eventId: ids[0] ?? "", reason: "refused" },
        { _tag: "TurnFailed", eventId: ids[0] ?? "", reason: "refused" },
      ],
    });
    await runInDurableObject(await agentOf(ownerId), (_, state) => {
      state.storage.sql.exec(
        "UPDATE inbox_events SET state = 'failed' WHERE event_id = ?",
        eventIds[0] ?? ""
      );
    });

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toEqual([]);
    expect(fakeTelegram.sent).toEqual([]);
    expect(await eventStates(ownerId)).toEqual(["failed", "failed", "failed"]);
  });

  it("answers the linked burst once when a reset came before the reply, also when bursts hold one Event", async () => {
    const ownerId = await addOwner(7105);
    await storeBurst(ownerId, 7105, { records: links });

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(ownerTextsOf(fakeModel.doGenerateCalls[0]?.prompt ?? [])).toEqual(
      burstTexts
    );
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(fakeTelegram.sent[0]?.body.reply_parameters).toMatchObject({
      message_id: 73,
    });
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
  });

  it("sends once for the burst after the Durable Object is reset in the middle of its Turn", async () => {
    const ownerId = await addOwner(7106);
    await storeBurst(ownerId, 7106);
    fakeBursts.allPendingTogether = true;
    const releaseModel = holdModel();
    const agent = await agentOf(ownerId);

    await runInDurableObject(agent, (instance) =>
      instance.schedule(0, "runTurn")
    );
    await vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(1));
    await abortAllDurableObjects();
    fakeBursts.allPendingTogether = false;
    releaseModel();
    await runDurableObjectAlarm(await agentOf(ownerId));

    await vi.waitFor(async () =>
      expect(await eventStates(ownerId)).toEqual(["done", "done", "done"])
    );
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(fakeTelegram.sent[0]?.body.reply_parameters).toMatchObject({
      message_id: 73,
    });
  });

  it("keeps a forwarded message of a Burst under its own source, keyed by the Turn Event", async () => {
    const ownerId = await addOwner(7107);
    const eventIds = await storeBurst(ownerId, 7107, { forwarded: [1] });
    fakeBursts.allPendingTogether = true;
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "keep this" } },
      { say: "Kept" },
    ]);

    await runTurn(ownerId);

    expect(await noteRows(ownerId)).toEqual([
      {
        text: "second",
        source_event_id: eventIds[0],
        source_channel_message_id: "72",
        trust_level: "untrusted",
      },
    ]);
  });

  it("refuses capture_note for a Burst with more than one forwarded message and keeps no Note", async () => {
    const ownerId = await addOwner(7108);
    await storeBurst(ownerId, 7108, { forwarded: [1, 2] });
    fakeBursts.allPendingTogether = true;
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "keep this" } },
      { say: "I could not keep it" },
    ]);

    await runTurn(ownerId);

    expect(await noteRows(ownerId)).toEqual([]);
    expect(fakeModel.doGenerateCalls).toHaveLength(2);
    expect(
      toolResultsOf(fakeModel.doGenerateCalls[1]?.prompt ?? []).join("\n")
    ).toContain(severalForwardedMessagesMessage);
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
  });

  it("mutes the Open Loops of a Proactive Message connected to a later Event of the Burst", async () => {
    const ownerId = await addOwner(7109);
    const eventIds = await storeBurst(ownerId, 7109);
    const { note } = await inPersonalAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          notes.capture({
            text: "buy a gift",
            source: {
              eventId: "seed-note",
              channel: "telegram",
              conversationId: "7109",
              channelMessageId: "1",
              trustLevel: "owner",
            },
            openLoop: { kind: "task" },
          })
        )
      )
    );
    await runInDurableObject(await agentOf(ownerId), (_, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "INSERT INTO proactive_messages (event_id, sent_message_id, open_loop_ids, planned_at, sent_at, window_ends_at, connected_event_id) VALUES ('seed-brief', '9001', ?, ?, ?, ?, ?)",
        JSON.stringify([note.noteId]),
        new Date(now - 60_000).toISOString(),
        new Date(now - 60_000).toISOString(),
        new Date(now + 3_600_000).toISOString(),
        eventIds[1] ?? ""
      );
    });
    fakeBursts.allPendingTogether = true;
    scriptModel([
      { callTool: muteProactiveMessageToolName, input: { action: "mute" } },
      { say: "Muted" },
    ]);

    await runTurn(ownerId);

    const mutes = await inPersonalAgent(
      ownerId,
      OwnerPreferences.pipe(
        Effect.flatMap((preferences) => preferences.proactiveMutes)
      )
    );
    expect(mutes.openLoopIds).toEqual([note.noteId]);
    const records = await journalRecords(ownerId);
    expect(records).toContainEqual(
      expect.objectContaining({
        _tag: "ProactiveMuteChanged",
        eventId: eventIds[0],
        change: "muted",
      })
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        _tag: "ProactiveMessageOutcome",
        eventId: "seed-brief",
        outcome: "muted",
        connectedEventId: eventIds[1],
      })
    );
  });
});
