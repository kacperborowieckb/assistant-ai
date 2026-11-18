import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { honestFailureText } from "../src/personal-agent/delivery.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { TurnProgress } from "../src/personal-agent/turn-progress.ts";
import {
  fakeModel,
  fakeReplyPrefix,
  failModel,
  fakeTelegram,
  holdModel,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

interface NoteRow extends Record<string, SqlStorageValue> {
  note_id: string;
  owner_id: string;
  text: string;
  url: string | null;
  source_event_id: string;
  source_channel: string;
  source_conversation_id: string;
  source_channel_message_id: string;
  trust_level: string;
  captured_at: string;
  last_checked_at: string;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const notesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<NoteRow>("SELECT * FROM notes").toArray()
  );

const journalOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Journal.pipe(
        Effect.flatMap((journal) => journal.read),
        Effect.map((entries) => entries.map((entry) => entry.record))
      )
    )
  );

const conversationRolesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<{ message: string }>(
        "SELECT message FROM conversation_messages ORDER BY sequence"
      )
      .toArray()
      .map((row) => (JSON.parse(row.message) as { role: string }).role)
  );

const capturedEntriesOf = async (ownerId: string) => {
  const records = await journalOf(ownerId);
  return records.filter((record) => record._tag === "NoteCaptured");
};

const captureNote = (input: { text: string; url?: string }) =>
  ({ callTool: captureNoteToolName, input }) as const;

const waitForReplies = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 10_000,
  });

beforeEach(() => {
  resetFakes();
});

describe("Capture a Note", () => {
  it("keeps a text as one Note of the Owner and says what was kept", async () => {
    const ownerId = await addOwner(7001);
    scriptModel([
      captureNote({ text: "buy a gift for Ana before Friday" }),
      { say: "Kept: buy a gift for Ana before Friday" },
    ]);

    await telegramWebhook(
      textUpdate({
        fromUserId: 7001,
        text: "buy a gift for Ana before Friday",
        messageId: 31,
      })
    );
    await waitForReplies(1);

    const [note, ...others] = await notesOf(ownerId);
    expect(others).toEqual([]);
    expect(note).toMatchObject({
      owner_id: ownerId,
      text: "buy a gift for Ana before Friday",
      url: null,
      source_channel: "telegram",
      source_conversation_id: "7001",
      source_channel_message_id: "31",
      trust_level: "owner",
    });
    expect(note?.captured_at).toBe(note?.last_checked_at);
    expect(fakeTelegram.sent.map((sent) => sent.body.text)).toEqual([
      "Kept: buy a gift for Ana before Friday",
    ]);
  });

  it("appends one Journal Entry with the Note id for the Note write", async () => {
    const ownerId = await addOwner(7002);
    scriptModel([captureNote({ text: "call Ana" }), { say: "Kept" }]);

    await telegramWebhook(textUpdate({ fromUserId: 7002, text: "call Ana" }));
    await waitForReplies(1);

    const [note] = await notesOf(ownerId);
    const captured = await capturedEntriesOf(ownerId);
    expect(captured).toEqual([
      {
        _tag: "NoteCaptured",
        eventId: note?.source_event_id,
        noteId: note?.note_id,
      },
    ]);
  });

  it("keeps a link with a comment and a link alone without a network request", async () => {
    const ownerId = await addOwner(7003);
    const network = vi.spyOn(globalThis, "fetch");
    scriptModel([
      captureNote({ text: "read later", url: "https://example.com/a" }),
      captureNote({
        text: "https://example.com/b",
        url: "https://example.com/b",
      }),
      { say: "Kept both" },
    ]);

    await telegramWebhook(
      textUpdate({
        fromUserId: 7003,
        text: "read later https://example.com/a and https://example.com/b",
      })
    );
    await waitForReplies(1);

    const rows = await notesOf(ownerId);
    expect(rows.map((row) => row.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(
      network.mock.calls.filter(([input]) => String(input).includes("example"))
    ).toEqual([]);
    const offered = fakeModel.doGenerateCalls[0]?.tools?.map(
      (offeredTool) => offeredTool.name
    );
    expect(offered).toContain(captureNoteToolName);
    expect(offered).not.toContain("fetch");
    network.mockRestore();
  });

  it("creates one Note and one reply when the model fails twice after the write", async () => {
    const ownerId = await addOwner(7004);
    scriptModel([
      captureNote({ text: "buy milk" }),
      { error: "The model provider is down" },
      { error: "The model provider is down" },
      { say: "Kept: buy milk" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 7004, text: "buy milk" }));
    await waitForReplies(1);

    expect(await notesOf(ownerId)).toHaveLength(1);
    expect(fakeTelegram.sent).toHaveLength(1);
  });

  it("creates one Note and one reply when the Durable Object resets after the write and before the reply", async () => {
    const ownerId = await addOwner(7005);
    scriptModel([captureNote({ text: "buy tea" }), { say: "Kept: buy tea" }]);
    const releaseModel = holdModel(1);

    await telegramWebhook(textUpdate({ fromUserId: 7005, text: "buy tea" }));
    await vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(2));
    expect(await notesOf(ownerId)).toHaveLength(1);
    await abortAllDurableObjects();
    scriptModel([{ say: "Kept: buy tea" }]);
    releaseModel();
    await runDurableObjectAlarm(await agentOf(ownerId));
    await waitForReplies(1);

    expect(await notesOf(ownerId)).toHaveLength(1);
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await capturedEntriesOf(ownerId)).toHaveLength(1);
    const recoveredPrompt = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
    const partTypes = recoveredPrompt.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.map((part) => part.type)
    );
    expect(partTypes).toEqual(
      expect.arrayContaining(["tool-call", "tool-result"])
    );
    expect(await conversationRolesOf(ownerId)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("writes nothing and tells the model the Note was not kept when the write fails", async () => {
    const ownerId = await addOwner(7006);
    await runInDurableObject(
      await agentOf(ownerId),
      async (instance, state) => {
        await instance.runtime.runPromise(Effect.void);
        state.storage.sql.exec(
          "CREATE TRIGGER notes_fail BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'disk full'); END"
        );
      }
    );
    scriptModel([
      captureNote({ text: "buy bread" }),
      { say: "Sorry, I could not keep that" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 7006, text: "buy bread" }));
    await waitForReplies(1);

    expect(await notesOf(ownerId)).toEqual([]);
    expect(await capturedEntriesOf(ownerId)).toEqual([]);
    expect(JSON.stringify(fakeModel.doGenerateCalls[1]?.prompt)).toContain(
      "The Note was not kept"
    );
    expect(JSON.stringify(fakeModel.doGenerateCalls[0]?.prompt)).toContain(
      "Say that you kept something only after"
    );
  });

  it("keeps a repeated write of the same text once", async () => {
    const ownerId = await addOwner(7007);
    scriptModel([
      captureNote({ text: "Buy  Milk" }),
      captureNote({ text: "buy milk " }),
      { say: "Kept" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 7007, text: "buy milk" }));
    await waitForReplies(1);

    expect(await notesOf(ownerId)).toHaveLength(1);
    expect(await capturedEntriesOf(ownerId)).toHaveLength(1);
  });

  it("keeps no Note when the Journal Entry of the write cannot be appended", async () => {
    const ownerId = await addOwner(7008);
    await runInDurableObject(
      await agentOf(ownerId),
      async (instance, state) => {
        await instance.runtime.runPromise(Effect.void);
        state.storage.sql.exec(
          "CREATE TRIGGER journal_fail BEFORE INSERT ON journal_entries WHEN NEW.kind = 'NoteCaptured' BEGIN SELECT RAISE(ABORT, 'disk full'); END"
        );
      }
    );
    scriptModel([
      captureNote({ text: "buy rice" }),
      { say: "Sorry, I could not keep that" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 7008, text: "buy rice" }));
    await waitForReplies(1);

    expect(await notesOf(ownerId)).toEqual([]);
    expect(JSON.stringify(fakeModel.doGenerateCalls[1]?.prompt)).toContain(
      "The Note was not kept"
    );
  });

  it("keeps no Note when the tool step of the write cannot be saved", async () => {
    const ownerId = await addOwner(7009);
    await runInDurableObject(
      await agentOf(ownerId),
      async (instance, state) => {
        await instance.runtime.runPromise(Effect.void);
        state.storage.sql.exec(
          "CREATE TRIGGER progress_fail BEFORE INSERT ON turn_progress BEGIN SELECT RAISE(ABORT, 'disk full'); END"
        );
      }
    );
    scriptModel([
      captureNote({ text: "buy salt" }),
      { say: "Sorry, I could not keep that" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 7009, text: "buy salt" }));
    await waitForReplies(1);

    expect(await notesOf(ownerId)).toEqual([]);
  });

  it("keeps the saved tool steps in the conversation when the restarted Turn fails", async () => {
    const ownerId = await addOwner(7010);
    scriptModel([captureNote({ text: "buy oil" }), { say: "Kept: buy oil" }]);
    const releaseModel = holdModel(1);

    await telegramWebhook(textUpdate({ fromUserId: 7010, text: "buy oil" }));
    await vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(2));
    await abortAllDurableObjects();
    failModel(3);
    releaseModel();
    await runDurableObjectAlarm(await agentOf(ownerId));
    await waitForReplies(1);

    expect(await notesOf(ownerId)).toHaveLength(1);
    expect(await conversationRolesOf(ownerId)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("keeps the saved capture in the conversation when the Durable Object resets after the reply was sent", async () => {
    const ownerId = await addOwner(7011);
    scriptModel([captureNote({ text: "buy jam" }), { say: "Kept: buy jam" }]);
    const agent = await agentOf(ownerId);
    await runInDurableObject(agent, async (instance) => {
      await instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const inbox = yield* Inbox;
          yield* inbox.store({
            _tag: "OwnerMessage",
            channel: "telegram",
            channelUpdateId: "reset-after-send",
            conversationId: "7011",
            channelMessageId: "90",
            text: "buy jam",
            sentAt: new Date().toISOString(),
          });
          const [event] = yield* inbox.pending;
          const journal = yield* Journal;
          const eventId = event?.eventId ?? "";
          const progress = yield* TurnProgress;
          yield* progress.recordingToolCall(
            {
              eventId,
              toolCallId: "call-1",
              toolName: captureNoteToolName,
              input: { text: "buy jam" },
              redactor: { redact: (text) => text, redactMessage: (m) => m },
            },
            Effect.succeed({ noteId: "n1" })
          );
          yield* journal.append({
            _tag: "ReplyPlanned",
            eventId,
            text: "Kept: buy jam",
          });
          yield* journal.append({ _tag: "SendStarted", eventId });
          yield* journal.append({
            _tag: "ReplySent",
            eventId,
            channelMessageId: "9100",
          });
        })
      );
      await instance.runTurn();
      await instance.runTurn();
    });

    expect(await conversationRolesOf(ownerId)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(fakeTelegram.sent).toEqual([]);
  });

  it("sends the honest failure instead of another step when saved tool calls use up the step limit", async () => {
    const ownerId = await addOwner(7012);
    const agent = await agentOf(ownerId);
    await runInDurableObject(agent, async (instance) => {
      await instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const inbox = yield* Inbox;
          yield* inbox.store({
            _tag: "OwnerMessage",
            channel: "telegram",
            channelUpdateId: "limit",
            conversationId: "7012",
            channelMessageId: "91",
            text: "keep many",
            sentAt: new Date().toISOString(),
          });
          const [event] = yield* inbox.pending;
          const progress = yield* TurnProgress;
          for (
            let index = 0;
            index < defaultBehaviorConfig.maxToolSteps;
            index += 1
          ) {
            yield* progress.markModelStep(event?.eventId ?? "", index);
            yield* progress.recordingToolCall(
              {
                eventId: event?.eventId ?? "",
                toolCallId: `call-${index}`,
                toolName: captureNoteToolName,
                input: { text: `note ${index}` },
                redactor: { redact: (text) => text, redactMessage: (m) => m },
              },
              Effect.succeed({ noteId: `n${index}` })
            );
          }
        })
      );
      await instance.runTurn();
    });

    expect(fakeModel.doGenerateCalls).toHaveLength(0);
    expect(fakeTelegram.sent.map((sent) => sent.body.text)).toEqual([
      honestFailureText,
    ]);
  });

  it("counts model steps whose tool call failed and saved nothing", async () => {
    const ownerId = await addOwner(7014);
    const agent = await agentOf(ownerId);
    await runInDurableObject(agent, async (instance) => {
      await instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const inbox = yield* Inbox;
          yield* inbox.store({
            _tag: "OwnerMessage",
            channel: "telegram",
            channelUpdateId: "failed-steps",
            conversationId: "7014",
            channelMessageId: "93",
            text: "keep many",
            sentAt: new Date().toISOString(),
          });
          const [event] = yield* inbox.pending;
          const progress = yield* TurnProgress;
          for (
            let index = 0;
            index < defaultBehaviorConfig.maxToolSteps;
            index += 1
          ) {
            yield* progress.markModelStep(event?.eventId ?? "", index);
          }
        })
      );
      await instance.runTurn();
    });

    expect(fakeModel.doGenerateCalls).toHaveLength(0);
    expect(fakeTelegram.sent.map((sent) => sent.body.text)).toEqual([
      honestFailureText,
    ]);
  });

  it("still asks the model for a reply when many saved tool calls came from one model step", async () => {
    const ownerId = await addOwner(7013);
    const agent = await agentOf(ownerId);
    await runInDurableObject(agent, async (instance) => {
      await instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const inbox = yield* Inbox;
          yield* inbox.store({
            _tag: "OwnerMessage",
            channel: "telegram",
            channelUpdateId: "one-step",
            conversationId: "7013",
            channelMessageId: "92",
            text: "keep many",
            sentAt: new Date().toISOString(),
          });
          const [event] = yield* inbox.pending;
          const progress = yield* TurnProgress;
          for (
            let index = 0;
            index < defaultBehaviorConfig.maxToolSteps;
            index += 1
          ) {
            yield* progress.markModelStep(event?.eventId ?? "", 5);
            yield* progress.recordingToolCall(
              {
                eventId: event?.eventId ?? "",
                toolCallId: `call-${index}`,
                toolName: captureNoteToolName,
                input: { text: `note ${index}` },
                redactor: { redact: (text) => text, redactMessage: (m) => m },
              },
              Effect.succeed({ noteId: `n${index}` })
            );
          }
        })
      );
      await instance.runTurn();
    });

    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(fakeTelegram.sent.map((sent) => sent.body.text)).toEqual([
      `${fakeReplyPrefix}keep many`,
    ]);
  });
});
