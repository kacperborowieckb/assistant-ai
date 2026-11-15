import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import type { JournalRecord } from "../src/journal/journal.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { searchNotesToolName } from "../src/notes/search-notes-tool.ts";
import { updateNoteToolName } from "../src/notes/update-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

interface NoteRow extends Record<string, SqlStorageValue> {
  note_id: string;
  text: string;
  source_event_id: string;
  source_channel_message_id: string;
  captured_at: string;
  last_checked_at: string;
}

interface LinkRow extends Record<string, SqlStorageValue> {
  from_note_id: string;
  to_note_id: string;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const notesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<NoteRow>("SELECT * FROM notes ORDER BY captured_at, note_id")
      .toArray()
  );

const linksOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<LinkRow>("SELECT * FROM note_links").toArray()
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

const recordsTagged = async <Tag extends JournalRecord["_tag"]>(
  ownerId: string,
  tag: Tag
) => {
  const records = await journalOf(ownerId);
  return records.filter(
    (record): record is Extract<JournalRecord, { _tag: Tag }> =>
      record._tag === tag
  );
};

const toolCallNamesOfTraces = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      TurnTraces.pipe(
        Effect.flatMap((traces) => traces.read),
        Effect.map((stored) =>
          stored.flatMap(({ trace }) =>
            trace.steps.flatMap((step) =>
              step.toolCalls.map((call) => call.name)
            )
          )
        )
      )
    )
  );

const searchOf = async (ownerId: string, query: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Notes.pipe(Effect.flatMap((notes) => notes.search({ query, limit: 5 })))
    )
  );

const waitForReplies = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 10_000,
  });

const ownerSays = async (userId: number, text: string, replies: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await waitForReplies(replies);
};

beforeEach(() => {
  resetFakes();
});

describe("Edit and link Notes", () => {
  it("changes the same Note for a follow-up and creates no new Note", async () => {
    const ownerId = await addOwner(7201);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "buy a gift for Ana" },
      },
      { say: "Kept" },
    ]);
    await ownerSays(7201, "buy a gift for Ana", 1);
    const [original] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: {
          noteId: original?.note_id,
          text: "buy a red scarf for Ana",
        },
      },
      { say: "Changed" },
    ]);

    await ownerSays(7201, "make it a red scarf", 2);

    const rows = await notesOf(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      note_id: original?.note_id,
      text: "buy a red scarf for Ana",
      captured_at: original?.captured_at,
    });
    expect(rows[0]?.last_checked_at).not.toBe(original?.last_checked_at);
  });

  it("finds the updated text and not the old text", async () => {
    const ownerId = await addOwner(7202);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy a gift for Ana" } },
      { say: "Kept" },
    ]);
    await ownerSays(7202, "buy a gift for Ana", 1);
    const [original] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: { noteId: original?.note_id, text: "buy a red scarf for Ana" },
      },
      { say: "Changed" },
    ]);
    await ownerSays(7202, "make it a red scarf", 2);

    expect(await searchOf(ownerId, "gift")).toEqual([]);
    const found = await searchOf(ownerId, "scarf");
    expect(found.map((note) => note.text)).toEqual(["buy a red scarf for Ana"]);
  });

  it("appends a Journal Entry and a Trace tool call for an update", async () => {
    const ownerId = await addOwner(7203);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "call the plumber" } },
      { say: "Kept" },
    ]);
    await ownerSays(7203, "call the plumber", 1);
    const [original] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: { noteId: original?.note_id, text: "call the plumber at 5" },
      },
      { say: "Changed" },
    ]);
    await ownerSays(7203, "at 5", 2);

    const updates = await recordsTagged(ownerId, "NoteUpdated");
    expect(updates).toEqual([
      expect.objectContaining({
        _tag: "NoteUpdated",
        noteId: original?.note_id,
        change: "text",
      }),
    ]);
    await vi.waitFor(async () =>
      expect(await toolCallNamesOfTraces(ownerId)).toContain(updateNoteToolName)
    );
  });

  it("links two related Notes, so that search returns the context", async () => {
    const ownerId = await addOwner(7204);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "Ana likes red" } },
      { say: "Kept" },
    ]);
    await ownerSays(7204, "Ana likes red", 1);
    const [first] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: {
          text: "Ana's birthday is on Friday",
          linkedNoteIds: [first?.note_id],
        },
      },
      { say: "Kept and linked" },
    ]);
    await ownerSays(7204, "Ana's birthday is on Friday", 2);

    const rows = await notesOf(ownerId);
    expect(rows).toHaveLength(2);
    const [link, ...others] = await linksOf(ownerId);
    expect(others).toEqual([]);
    expect(new Set([link?.from_note_id, link?.to_note_id])).toEqual(
      new Set(rows.map((row) => row.note_id))
    );
    const found = await searchOf(ownerId, "birthday");
    expect(found).toHaveLength(1);
    expect(found[0]?.linkedNotes.map((note) => note.text)).toEqual([
      "Ana likes red",
    ]);
    const fromOtherSide = await searchOf(ownerId, "likes");
    expect(fromOtherSide[0]?.linkedNotes.map((note) => note.text)).toEqual([
      "Ana's birthday is on Friday",
    ]);
  });

  it("returns an error and writes nothing when a link names an unknown Note", async () => {
    const ownerId = await addOwner(7205);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "new idea", linkedNoteIds: ["no-such-note"] },
      },
      { say: "Sorry, I could not keep that" },
    ]);

    await ownerSays(7205, "new idea", 1);

    expect(await notesOf(ownerId)).toEqual([]);
    expect(await linksOf(ownerId)).toEqual([]);
    expect(await recordsTagged(ownerId, "NoteCaptured")).toEqual([]);
    expect(JSON.stringify(fakeModel.doGenerateCalls[1]?.prompt)).toContain(
      "No Note of the Owner has the id no-such-note"
    );
  });

  it("returns an error and changes nothing when an update names an unknown Note", async () => {
    const ownerId = await addOwner(7206);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy tea" } },
      { say: "Kept" },
    ]);
    await ownerSays(7206, "buy tea", 1);
    const [original] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: {
          noteId: original?.note_id,
          text: "buy coffee",
          linkedNoteIds: ["no-such-note"],
        },
      },
      { say: "Sorry" },
    ]);

    await ownerSays(7206, "make it coffee", 2);

    expect(await notesOf(ownerId)).toEqual([original]);
    expect(await linksOf(ownerId)).toEqual([]);
    expect(await recordsTagged(ownerId, "NoteUpdated")).toEqual([]);
    expect(await searchOf(ownerId, "coffee")).toEqual([]);
  });

  it("refuses an update that changes nothing", async () => {
    const ownerId = await addOwner(7207);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy salt" } },
      { say: "Kept" },
    ]);
    await ownerSays(7207, "buy salt", 1);
    const [original] = await notesOf(ownerId);
    scriptModel([
      { callTool: updateNoteToolName, input: { noteId: original?.note_id } },
      { say: "Nothing to change" },
    ]);

    await ownerSays(7207, "hm", 2);

    expect(JSON.stringify(fakeModel.doGenerateCalls.at(-1)?.prompt)).toContain(
      "Give new text, Notes to link, or Notes to unlink"
    );
    expect(await notesOf(ownerId)).toEqual([original]);
  });

  it("links and unlinks Notes with an update and records the kind of change", async () => {
    const ownerId = await addOwner(7208);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "idea a" } },
      { callTool: captureNoteToolName, input: { text: "idea b" } },
      { say: "Kept" },
    ]);
    await ownerSays(7208, "two ideas", 1);
    const [a, b] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: { noteId: a?.note_id, linkedNoteIds: [b?.note_id] },
      },
      { say: "Linked" },
    ]);
    await ownerSays(7208, "link them", 2);
    expect(await linksOf(ownerId)).toHaveLength(1);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: {
          noteId: b?.note_id,
          text: "idea b, final",
          unlinkedNoteIds: [a?.note_id],
        },
      },
      { say: "Unlinked" },
    ]);

    await ownerSays(7208, "unlink and finalize", 3);

    expect(await linksOf(ownerId)).toEqual([]);
    const updates = await recordsTagged(ownerId, "NoteUpdated");
    const changes = updates.map((record) => record.change);
    expect(changes).toEqual(["links", "text_and_links"]);
  });

  it("lets two Notes of one Event take the same edited text", async () => {
    const ownerId = await addOwner(7209);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy a gift for Ana" } },
      { callTool: captureNoteToolName, input: { text: "buy a book for Tom" } },
      { say: "Kept" },
    ]);
    await ownerSays(7209, "two gifts", 1);
    const [gift, book] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: { noteId: gift?.note_id, text: "buy a scarf" },
      },
      {
        callTool: updateNoteToolName,
        input: { noteId: book?.note_id, text: "buy a scarf" },
      },
      { say: "Changed both" },
    ]);
    await ownerSays(7209, "make both a scarf", 2);

    const rows = await notesOf(ownerId);
    expect(rows.map((row) => row.text)).toEqual(["buy a scarf", "buy a scarf"]);
  });

  it("returns the existing Note when the original capture repeats after an edit of the same Event", async () => {
    const ownerId = await addOwner(7211);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy a gift for Ana" } },
      { say: "Kept" },
    ]);
    await ownerSays(7211, "buy a gift for Ana", 1);
    const [original] = await notesOf(ownerId);
    const eventSource = {
      eventId: original?.source_event_id ?? "",
      channel: "telegram",
      conversationId: "7211",
      channelMessageId: original?.source_channel_message_id ?? "",
      trustLevel: "owner",
    } as const;

    const second = await runInDurableObject(
      await agentOf(ownerId),
      (instance) =>
        instance.runtime.runPromise(
          Effect.gen(function* repeatEffect() {
            const notes = yield* Notes;
            yield* notes.update({
              noteId: original?.note_id ?? "",
              eventId: eventSource.eventId,
              text: "buy a red scarf for Ana",
            });
            return yield* notes.capture({
              text: "buy a gift for Ana",
              source: eventSource,
            });
          })
        )
    );

    expect(second.alreadyKept).toBe(true);
    expect(await notesOf(ownerId)).toHaveLength(1);
  });

  it("does not restore a removed link when the same capture repeats", async () => {
    const ownerId = await addOwner(7212);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "Ana likes red" } },
      { say: "Kept" },
    ]);
    await ownerSays(7212, "Ana likes red", 1);
    const [first] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "Ana birthday", linkedNoteIds: [first?.note_id] },
      },
      { say: "Kept" },
    ]);
    await ownerSays(7212, "Ana birthday", 2);
    const [, second] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: { noteId: second?.note_id, unlinkedNoteIds: [first?.note_id] },
      },
      { say: "Unlinked" },
    ]);
    await ownerSays(7212, "unlink", 3);
    expect(await linksOf(ownerId)).toEqual([]);

    const repeated = await runInDurableObject(
      await agentOf(ownerId),
      (instance) =>
        instance.runtime.runPromise(
          Notes.pipe(
            Effect.flatMap((notes) =>
              notes.capture({
                text: "Ana birthday",
                linkedNoteIds: [first?.note_id ?? ""],
                source: {
                  eventId: second?.source_event_id ?? "",
                  channel: "telegram",
                  conversationId: "7212",
                  channelMessageId: second?.source_channel_message_id ?? "",
                  trustLevel: "owner",
                },
              })
            )
          )
        )
    );

    expect(repeated.alreadyKept).toBe(true);
    expect(repeated.linkedNoteIds).toEqual([]);
    expect(await linksOf(ownerId)).toEqual([]);
  });

  it("returns the source and the URL of linked Notes in a search result", async () => {
    const ownerId = await addOwner(7210);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "read later", url: "https://example.com/gifts" },
      },
      { say: "Kept" },
    ]);
    await ownerSays(7210, "read later", 1);
    const [first] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "gift ideas", linkedNoteIds: [first?.note_id] },
      },
      { say: "Kept" },
    ]);
    await ownerSays(7210, "gift ideas", 2);
    scriptModel([
      { callTool: searchNotesToolName, input: { query: "ideas" } },
      { say: "Found" },
    ]);

    await ownerSays(7210, "what are my gift ideas?", 3);

    const resultPrompt = JSON.stringify(
      fakeModel.doGenerateCalls.at(-1)?.prompt
    );
    expect(resultPrompt).toContain("https://example.com/gifts");
    expect(resultPrompt).toContain("channelMessageId");
  });
});
