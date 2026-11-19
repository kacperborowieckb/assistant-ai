import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import type { JournalRecord } from "../src/journal/journal.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import {
  closeOpenLoopToolName,
  noOpenLoopMessage,
} from "../src/notes/close-open-loop-tool.ts";
import {
  listOpenLoopsToolName,
  openLoopsPerPage,
} from "../src/notes/list-open-loops-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { noTimeZoneForOpenLoopMessage } from "../src/notes/open-loop-input.ts";
import { searchNotesToolName } from "../src/notes/search-notes-tool.ts";
import { updateNoteToolName } from "../src/notes/update-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import {
  fakeModel,
  fakeTelegram,
  holdModel,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

interface OpenLoopRow extends Record<string, SqlStorageValue> {
  note_id: string;
  text: string;
  trust_level: string;
  open_loop_kind: string | null;
  open_loop_state: string | null;
  open_loop_closed_reason: string | null;
  open_loop_due_at: string | null;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Journal | Notes | OwnerPreferences>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const notesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<OpenLoopRow>(
        "SELECT note_id, text, trust_level, open_loop_kind, open_loop_state, open_loop_closed_reason, open_loop_due_at FROM notes ORDER BY captured_at, note_id"
      )
      .toArray()
  );

const openLoopRecordsOf = async (ownerId: string) => {
  const entries = await inAgent(
    ownerId,
    Journal.pipe(Effect.flatMap((journal) => journal.read))
  );
  return entries
    .map((entry) => entry.record)
    .filter(
      (
        record
      ): record is Extract<
        JournalRecord,
        { _tag: "OpenLoopOpened" | "OpenLoopChanged" | "OpenLoopClosed" }
      > => record._tag.startsWith("OpenLoop")
    );
};

const ownerInWarsaw = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  await inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setTimeZone("Europe/Warsaw", "setup")
      )
    )
  );
  return ownerId;
};

const ownerSays = async (userId: number, text: string, replies: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(replies), {
    timeout: 10_000,
  });
};

const lastToolResultOf = (toolName: string) => {
  const prompt = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
  const parts = prompt.flatMap((message) =>
    message.role === "tool" ? message.content : []
  );
  const part = parts.findLast(
    (candidate) =>
      candidate.type === "tool-result" && candidate.toolName === toolName
  );
  return part?.type === "tool-result" ? part.output : undefined;
};

const offeredToolsOf = (call: number) =>
  (fakeModel.doGenerateCalls[call]?.tools ?? []).map((tool) => tool.name);

const nextYear = DateTime.getPartUtc(DateTime.nowUnsafe(), "year") + 1;

const dueInFebruary = (day: number) =>
  DateTime.makeUnsafe(
    `${nextYear}-02-${String(day).padStart(2, "0")}T09:00:00.000Z`
  );

const giftTask = {
  text: "buy a gift for Ana before Friday",
  openLoop: { kind: "task", localDueTime: `${nextYear}-01-15T18:00` },
};

const sourceOfEvent = (eventId: string) =>
  ({
    eventId,
    channel: "telegram",
    conversationId: "7213",
    channelMessageId: eventId,
    trustLevel: "owner",
  }) as const;

beforeEach(() => {
  resetFakes();
});

describe("Open Loops on Notes", () => {
  it("keeps a task as one Note with an open Open Loop and an OpenLoopOpened Journal Entry", async () => {
    const ownerId = await ownerInWarsaw(9801);
    scriptModel([
      { callTool: captureNoteToolName, input: giftTask },
      { say: "Kept" },
    ]);

    await ownerSays(9801, giftTask.text, 1);

    const rows = await notesOf(ownerId);
    expect(rows).toEqual([
      expect.objectContaining({
        text: giftTask.text,
        open_loop_kind: "task",
        open_loop_state: "open",
        open_loop_closed_reason: null,
        open_loop_due_at: `${nextYear}-01-15T17:00:00.000Z`,
      }),
    ]);
    expect(await openLoopRecordsOf(ownerId)).toEqual([
      expect.objectContaining({
        _tag: "OpenLoopOpened",
        noteId: rows[0]?.note_id,
        kind: "task",
        dueAt: `${nextYear}-01-15T17:00:00.000Z`,
      }),
    ]);
    expect(lastToolResultOf(captureNoteToolName)).toMatchObject({
      type: "json",
      value: {
        openLoop: {
          kind: "task",
          state: "open",
          closedReason: null,
          localDueTime: expect.stringContaining(`${nextYear}-01-15, 18:00`),
        },
      },
    });
  });

  it("keeps a fact with no Open Loop", async () => {
    const ownerId = await addOwner(9802);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "Tom likes Osteria" } },
      { say: "Kept" },
    ]);

    await ownerSays(9802, "Tom likes Osteria", 1);

    expect(await notesOf(ownerId)).toEqual([
      expect.objectContaining({
        open_loop_kind: null,
        open_loop_state: null,
        open_loop_due_at: null,
      }),
    ]);
    expect(await openLoopRecordsOf(ownerId)).toEqual([]);
  });

  it("refuses a due time when the time zone is not known and keeps nothing", async () => {
    const ownerId = await addOwner(9803);
    scriptModel([
      { callTool: captureNoteToolName, input: giftTask },
      { say: "Which time zone?" },
    ]);

    await ownerSays(9803, giftTask.text, 1);

    expect(await notesOf(ownerId)).toEqual([]);
    expect(lastToolResultOf(captureNoteToolName)).toMatchObject({
      type: "error-text",
      value: expect.stringContaining(
        noTimeZoneForOpenLoopMessage({
          toolName: captureNoteToolName,
          consequence: "Nothing was kept.",
        })
      ),
    });
  });

  it("opens an Open Loop on an existing Note with update_note and changes its due time", async () => {
    const ownerId = await ownerInWarsaw(9804);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "renew the passport" } },
      { say: "Kept" },
    ]);
    await ownerSays(9804, "renew the passport", 1);
    const [note] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: { noteId: note?.note_id, openLoop: { kind: "task" } },
      },
      { say: "Noted as open" },
    ]);
    await ownerSays(9804, "I still need to renew the passport", 2);
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: {
          noteId: note?.note_id,
          openLoop: { kind: "task", localDueTime: `${nextYear}-03-01T09:00` },
        },
      },
      { say: "Due 1 March" },
    ]);
    await ownerSays(9804, "do it by 1 March", 3);

    expect(await notesOf(ownerId)).toEqual([
      expect.objectContaining({
        text: "renew the passport",
        open_loop_kind: "task",
        open_loop_state: "open",
        open_loop_due_at: `${nextYear}-03-01T08:00:00.000Z`,
      }),
    ]);
    expect(await openLoopRecordsOf(ownerId)).toEqual([
      expect.objectContaining({
        _tag: "OpenLoopOpened",
        noteId: note?.note_id,
        kind: "task",
        dueAt: null,
      }),
      expect.objectContaining({
        _tag: "OpenLoopChanged",
        noteId: note?.note_id,
        kind: "task",
        dueAt: `${nextYear}-03-01T08:00:00.000Z`,
      }),
    ]);
    const records = await inAgent(
      ownerId,
      Journal.pipe(Effect.flatMap((journal) => journal.read))
    );
    expect(
      records.filter((entry) => entry.record._tag === "NoteUpdated")
    ).toEqual([]);
  });

  it("closes an Open Loop with a reason and writes OpenLoopClosed", async () => {
    const ownerId = await ownerInWarsaw(9805);
    scriptModel([
      { callTool: captureNoteToolName, input: giftTask },
      { say: "Kept" },
    ]);
    await ownerSays(9805, giftTask.text, 1);
    const [note] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: closeOpenLoopToolName,
        input: { noteId: note?.note_id, reason: "done" },
      },
      { say: "Closed" },
    ]);

    await ownerSays(9805, "I bought the gift", 2);

    expect(await notesOf(ownerId)).toEqual([
      expect.objectContaining({
        open_loop_kind: "task",
        open_loop_state: "closed",
        open_loop_closed_reason: "done",
        open_loop_due_at: `${nextYear}-01-15T17:00:00.000Z`,
      }),
    ]);
    const records = await openLoopRecordsOf(ownerId);
    expect(records.at(-1)).toEqual(
      expect.objectContaining({
        _tag: "OpenLoopClosed",
        noteId: note?.note_id,
        reason: "done",
      })
    );
  });

  it("gives a tool error and writes nothing for an unknown Note or a Note with no open Open Loop", async () => {
    const ownerId = await addOwner(9806);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "Tom likes Osteria" } },
      { say: "Kept" },
    ]);
    await ownerSays(9806, "Tom likes Osteria", 1);
    const [fact] = await notesOf(ownerId);
    scriptModel([
      {
        callTool: closeOpenLoopToolName,
        input: { noteId: "no-such-note", reason: "done" },
      },
      {
        callTool: closeOpenLoopToolName,
        input: { noteId: fact?.note_id, reason: "dropped" },
      },
      { say: "Nothing to close" },
    ]);

    await ownerSays(9806, "that is done", 2);

    const toolResults = (fakeModel.doGenerateCalls.at(-1)?.prompt ?? [])
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .flatMap((part) =>
        part.type === "tool-result" && part.toolName === closeOpenLoopToolName
          ? [part.output]
          : []
      );
    expect(toolResults).toEqual([
      {
        type: "error-text",
        value: expect.stringContaining(
          "No Note of the Owner has the id no-such-note. Nothing was closed."
        ),
      },
      {
        type: "error-text",
        value: expect.stringContaining(noOpenLoopMessage(fact?.note_id ?? "")),
      },
    ]);
    expect(await notesOf(ownerId)).toEqual([
      expect.objectContaining({ open_loop_state: null }),
    ]);
    expect(await openLoopRecordsOf(ownerId)).toEqual([]);
  });

  it("lists open Open Loops only, the earliest due first, with paging", async () => {
    const ownerId = await addOwner(9807);
    const expectedOrder = await inAgent(
      ownerId,
      Effect.gen(function* seedEffect() {
        const notes = yield* Notes;
        const keep = (
          text: string,
          openLoop?: { kind: string; dueAt?: DateTime.Utc }
        ) =>
          notes
            .capture({ text, source: sourceOfEvent(text), openLoop })
            .pipe(Effect.map(({ note }) => note.noteId));
        const noDue = yield* keep("open with no due date", { kind: "task" });
        const late = yield* keep("due on the 20th", {
          kind: "task",
          dueAt: dueInFebruary(20),
        });
        const closed = yield* keep("closed and due first", {
          kind: "task",
          dueAt: dueInFebruary(1),
        });
        yield* notes.closeOpenLoop({
          noteId: closed,
          eventId: "close",
          reason: "done",
        });
        yield* keep("a fact");
        const early = yield* keep("due on the 3rd", {
          kind: "waiting",
          dueAt: dueInFebruary(3),
        });
        const more: string[] = [];
        for (let index = 0; index < openLoopsPerPage; index += 1) {
          more.push(
            yield* keep(`due later ${index}`, {
              kind: "task",
              dueAt: dueInFebruary(21 + (index % 5)),
            })
          );
        }
        return { noDue, late, early, more };
      })
    );

    const [first, second] = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          Effect.all([
            notes.listOpenLoops({ offset: 0, limit: openLoopsPerPage }),
            notes.listOpenLoops({
              offset: openLoopsPerPage,
              limit: openLoopsPerPage,
            }),
          ])
        )
      )
    );
    const listed = [...(first?.notes ?? []), ...(second?.notes ?? [])];
    expect(first?.openLoopCount).toBe(openLoopsPerPage + 3);
    expect(first?.notes).toHaveLength(openLoopsPerPage);
    expect(listed.map((note) => note.noteId).slice(0, 2)).toEqual([
      expectedOrder.early,
      expectedOrder.late,
    ]);
    expect(listed.at(-1)?.noteId).toBe(expectedOrder.noDue);
    expect(listed.every((note) => note.openLoop?._tag === "Open")).toBe(true);
    const dues = listed.flatMap((note) =>
      note.openLoop?.dueAt === undefined
        ? []
        : [DateTime.toEpochMillis(note.openLoop.dueAt)]
    );
    expect(dues).toEqual(dues.toSorted((left, right) => left - right));
    expect(new Set(listed.map((note) => note.noteId)).size).toBe(
      openLoopsPerPage + 3
    );
  });

  it("returns open Open Loops from list_open_loops and the Open Loop of each Note from search_notes", async () => {
    await ownerInWarsaw(9808);
    scriptModel([
      { callTool: captureNoteToolName, input: giftTask },
      { callTool: captureNoteToolName, input: { text: "Ana likes scarves" } },
      { say: "Kept" },
    ]);
    await ownerSays(9808, "gift for Ana; she likes scarves", 1);
    scriptModel([
      { callTool: listOpenLoopsToolName, input: {} },
      { callTool: searchNotesToolName, input: { query: "Ana" } },
      { say: "One open" },
    ]);

    await ownerSays(9808, "what is open?", 2);

    expect(lastToolResultOf(listOpenLoopsToolName)).toMatchObject({
      type: "json",
      value: {
        openLoopCount: 1,
        nextOffset: null,
        openLoops: [
          {
            text: giftTask.text,
            openLoop: { kind: "task", state: "open" },
          },
        ],
      },
    });
    const search = lastToolResultOf(searchNotesToolName);
    expect(search?.type).toBe("json");
    const found =
      search?.type === "json"
        ? (search.value as { notes: { text: string; openLoop: unknown }[] })
            .notes
        : [];
    expect(
      Object.fromEntries(found.map((note) => [note.text, note.openLoop]))
    ).toEqual({
      [giftTask.text]: expect.objectContaining({ kind: "task", state: "open" }),
      "Ana likes scarves": null,
    });
  });

  it("refuses inconsistent Open Loop columns in the database", async () => {
    const ownerId = await addOwner(9809);
    const noteId = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          notes.capture({
            text: "call the plumber",
            source: sourceOfEvent("plumber"),
            openLoop: { kind: "task" },
          })
        ),
        Effect.map(({ note }) => note.noteId)
      )
    );
    const inconsistentUpdates = [
      "open_loop_closed_reason = 'done'",
      "open_loop_state = 'closed'",
      "open_loop_state = 'archived'",
      "open_loop_state = 'closed', open_loop_closed_reason = 'forgotten'",
      "open_loop_kind = NULL",
      "open_loop_kind = '  '",
      "open_loop_kind = NULL, open_loop_state = NULL, open_loop_due_at = '2026-01-01T00:00:00.000Z'",
    ];

    const refused = await runInDurableObject(
      await agentOf(ownerId),
      (_, state) =>
        inconsistentUpdates.map((update) => {
          try {
            state.storage.sql.exec(
              `UPDATE notes SET ${update} WHERE note_id = ?`,
              noteId
            );
            return `accepted: ${update}`;
          } catch (error) {
            return String(error).includes("CHECK constraint failed")
              ? "refused"
              : String(error);
          }
        })
    );

    expect(refused).toEqual(inconsistentUpdates.map(() => "refused"));
    expect(await notesOf(ownerId)).toEqual([
      expect.objectContaining({
        open_loop_kind: "task",
        open_loop_state: "open",
      }),
    ]);
  });

  it("writes no second change or Journal Entry when a close repeats after a Durable Object reset", async () => {
    const ownerId = await addOwner(9810);
    const noteId = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          notes.capture({
            text: "buy tea",
            source: sourceOfEvent("tea"),
            openLoop: { kind: "task" },
          })
        ),
        Effect.map(({ note }) => note.noteId)
      )
    );
    const close = {
      callTool: closeOpenLoopToolName,
      input: { noteId, reason: "done" },
    } as const;
    scriptModel([close, { say: "Closed" }]);
    const releaseModel = holdModel(1);

    await telegramWebhook(
      textUpdate({ fromUserId: 9810, text: "bought the tea" })
    );
    await vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(2));
    await abortAllDurableObjects();
    scriptModel([close, { say: "Closed" }]);
    releaseModel();
    await runDurableObjectAlarm(await agentOf(ownerId));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });

    const records = await openLoopRecordsOf(ownerId);
    expect(
      records.filter((record) => record._tag === "OpenLoopClosed")
    ).toHaveLength(1);
    expect(lastToolResultOf(closeOpenLoopToolName)).toMatchObject({
      type: "json",
      value: { alreadyClosed: true, openLoop: { state: "closed" } },
    });
  });

  it("writes no second change or Journal Entry when an update repeats after a Durable Object reset", async () => {
    const ownerId = await addOwner(9811);
    const [noteId, shopId] = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          Effect.all(
            ["fix the bike", "the bike shop on Main Street"].map((text) =>
              notes.capture({ text, source: sourceOfEvent(text) })
            )
          )
        ),
        Effect.map((captures) => captures.map(({ note }) => note.noteId))
      )
    );
    const open = {
      callTool: updateNoteToolName,
      input: {
        noteId,
        text: "fix the bike on Sunday",
        linkedNoteIds: [shopId],
        openLoop: { kind: "task" },
      },
    } as const;
    const storedState = async () =>
      runInDurableObject(await agentOf(ownerId), (_, state) => ({
        note: state.storage.sql
          .exec("SELECT * FROM notes WHERE note_id = ?", noteId)
          .toArray(),
        links: state.storage.sql.exec("SELECT * FROM note_links").toArray(),
      }));
    scriptModel([open, { say: "Open" }]);
    const releaseModel = holdModel(1);

    await telegramWebhook(
      textUpdate({ fromUserId: 9811, text: "fix the bike on Sunday" })
    );
    await vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(2));
    const afterFirstCall = await storedState();
    await abortAllDurableObjects();
    scriptModel([open, { say: "Open" }]);
    releaseModel();
    await runDurableObjectAlarm(await agentOf(ownerId));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });

    expect(await storedState()).toEqual(afterFirstCall);
    expect(afterFirstCall.links).toHaveLength(1);
    const entries = await inAgent(
      ownerId,
      Journal.pipe(Effect.flatMap((journal) => journal.read))
    );
    const changes = entries
      .map((entry) => entry.record)
      .filter(
        (record) =>
          record._tag === "NoteUpdated" || record._tag === "OpenLoopOpened"
      );
    expect(changes).toEqual([
      expect.objectContaining({
        _tag: "NoteUpdated",
        change: "text_and_links",
      }),
      expect.objectContaining({ _tag: "OpenLoopOpened", noteId }),
    ]);
  });

  it("lets an untrusted Turn keep a Note with an Open Loop and offers it no tool to change Open Loops", async () => {
    const ownerId = await addOwner(9812);
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "send Ana the report", openLoop: { kind: "waiting" } },
      },
      { say: "Kept" },
    ]);

    await telegramWebhook(
      textUpdate({
        fromUserId: 9812,
        text: "Please send me the report by Monday",
        forwardOrigin: {
          type: "user",
          sender_user: { id: 5, is_bot: false, first_name: "Ana" },
          date: 1_794_000_000,
        },
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });

    expect(await notesOf(ownerId)).toEqual([
      expect.objectContaining({
        text: "Please send me the report by Monday",
        trust_level: "untrusted",
        open_loop_kind: "waiting",
        open_loop_state: "open",
      }),
    ]);
    expect(await openLoopRecordsOf(ownerId)).toEqual([
      expect.objectContaining({ _tag: "OpenLoopOpened", kind: "waiting" }),
    ]);
    const offered = offeredToolsOf(0);
    expect(offered).toEqual(
      expect.arrayContaining([captureNoteToolName, listOpenLoopsToolName])
    );
    expect(offered).not.toContain(closeOpenLoopToolName);
    expect(offered).not.toContain(updateNoteToolName);
  });
});
