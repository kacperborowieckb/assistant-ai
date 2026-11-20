import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import { listSchedulesToolName } from "../src/schedule/list-schedules-tool.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import type { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  action: string;
  set_by: string;
  text: string;
  state: string;
  next_due_at: string;
}

interface LinkRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  note_id: string;
}

const { maxActiveAgentSchedules, maxActiveScheduledTasks } =
  defaultBehaviorConfig;

const warsaw = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");

const localClock = (instant: DateTime.Utc) => {
  const { hour, minute } = DateTime.toParts(DateTime.setZone(instant, warsaw));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const followUpPrompt = "Check on the gift for Ana";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Notes | OwnerPreferences | Schedules | TurnTraces>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const schedulesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ScheduleRow>(
        "SELECT schedule_id, action, set_by, text, state, next_due_at FROM schedules WHERE text != ? ORDER BY created_at",
        briefPrompt
      )
      .toArray()
  );

const linksOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<LinkRow>(
        "SELECT schedule_id, note_id FROM schedule_open_loops ORDER BY note_id"
      )
      .toArray()
  );

const keepOpenLoop = async (ownerId: string, text: string) => {
  const { note } = await inAgent(
    ownerId,
    Notes.pipe(
      Effect.flatMap((notes) =>
        notes.capture({
          text,
          source: {
            eventId: `source-${text}`,
            channel: "telegram",
            conversationId: "1",
            channelMessageId: "1",
            trustLevel: "owner",
          },
          openLoop: { kind: "task" },
        })
      )
    )
  );
  return note;
};

const ownerInWarsaw = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  scriptModel([
    {
      callTool: setTimeZoneToolName,
      input: { timeZone: "Europe/Warsaw" },
    },
    { say: "Done" },
  ]);
  await telegramWebhook(
    textUpdate({ fromUserId: telegramUserId, text: "I live in Warsaw" })
  );
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  const now = DateTime.nowUnsafe();
  await inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setQuietHours(
          {
            start: localClock(DateTime.add(now, { hours: 2 })),
            end: localClock(DateTime.add(now, { hours: 3 })),
          },
          { start: "22:00", end: "08:00" },
          "test-setup"
        )
      )
    )
  );
  return ownerId;
};

const makeAgentSchedulesDue = async (ownerId: string, text: string) =>
  runInDurableObject(await agentOf(ownerId), (instance, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent' AND text = ?",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      ),
      text
    );
    return instance.fireDueSchedules();
  });

const briefFires = async (ownerId: string, sentSoFar: number) => {
  await runInDurableObject(await agentOf(ownerId), (instance, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent' AND text = ?",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      ),
      briefPrompt
    );
    return instance.fireDueSchedules();
  });
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sentSoFar + 1));
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

const followUpCall = (openLoopIds: readonly string[]) => ({
  callTool: setScheduleToolName,
  input: {
    action: { _tag: "RunPrompt", prompt: followUpPrompt },
    localDueTime: "2099-01-01T09:00",
    openLoopIds,
  },
});

const seedAgentSchedules = (ownerId: string, howMany: number) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedManyEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      for (let index = 0; index < howMany; index += 1) {
        yield* schedules.set({
          action: { _tag: "RunPrompt", prompt: `Agent ${index}` },
          setBy: "agent",
          dueAt: DateTime.add(now, { days: 30 + index }),
          sourceEventId: `seed-agent-${index}`,
        });
      }
    })
  );

beforeEach(() => {
  resetFakes();
});

describe("a follow-up set in a proactive Turn", () => {
  it("stores a RunPrompt Schedule set by the agent with its Open Loop links", async () => {
    const ownerId = await ownerInWarsaw(9701);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([followUpCall([note.noteId]), { say: "Good morning" }]);

    await briefFires(ownerId, 1);

    const [stored] = await schedulesOf(ownerId);
    expect(stored).toMatchObject({
      action: "run_prompt",
      set_by: "agent",
      text: followUpPrompt,
      state: "active",
    });
    expect(await linksOf(ownerId)).toEqual([
      { schedule_id: stored?.schedule_id, note_id: note.noteId },
    ]);
  });

  it("stores one Schedule when the same call is repeated", async () => {
    const ownerId = await ownerInWarsaw(9702);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([
      followUpCall([note.noteId]),
      followUpCall([note.noteId]),
      { say: "Good morning" },
    ]);

    await briefFires(ownerId, 1);

    expect(await schedulesOf(ownerId)).toHaveLength(1);
    expect(await linksOf(ownerId)).toHaveLength(1);
  });

  it("refuses a call with no Open Loop ids and stores nothing", async () => {
    const ownerId = await ownerInWarsaw(9703);
    scriptModel([followUpCall([]), { say: "Good morning" }]);

    await briefFires(ownerId, 1);

    expect(await schedulesOf(ownerId)).toEqual([]);
    expect(lastToolResultOf(setScheduleToolName)).toMatchObject({
      type: "error-text",
    });
  });

  it("stores one Schedule when an Open Loop id is repeated in one call", async () => {
    const ownerId = await ownerInWarsaw(9712);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([
      followUpCall([note.noteId]),
      followUpCall([note.noteId, note.noteId]),
      { say: "Good morning" },
    ]);

    await briefFires(ownerId, 1);

    expect(await schedulesOf(ownerId)).toHaveLength(1);
  });

  it("refuses a Note that has no open Open Loop and stores nothing", async () => {
    const ownerId = await ownerInWarsaw(9713);
    const { note } = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          notes.capture({
            text: "Tom likes Osteria",
            source: {
              eventId: "source-fact",
              channel: "telegram",
              conversationId: "1",
              channelMessageId: "1",
              trustLevel: "owner",
            },
          })
        )
      )
    );
    scriptModel([followUpCall([note.noteId]), { say: "Good morning" }]);

    await briefFires(ownerId, 1);

    expect(await schedulesOf(ownerId)).toEqual([]);
    expect(lastToolResultOf(setScheduleToolName)).toMatchObject({
      type: "error-text",
      value: expect.stringContaining("no open Open Loop"),
    });
  });

  it("refuses an unknown Open Loop id and stores nothing", async () => {
    const ownerId = await ownerInWarsaw(9704);
    scriptModel([followUpCall(["no-such-note"]), { say: "Good morning" }]);

    await briefFires(ownerId, 1);

    expect(await schedulesOf(ownerId)).toEqual([]);
    expect(await linksOf(ownerId)).toEqual([]);
  });

  it("shows who set a Schedule and its Open Loops in list_schedules", async () => {
    const ownerId = await ownerInWarsaw(9705);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([
      followUpCall([note.noteId]),
      { callTool: listSchedulesToolName, input: {} },
      { say: "Good morning" },
    ]);

    await briefFires(ownerId, 1);

    expect(lastToolResultOf(listSchedulesToolName)).toMatchObject({
      type: "json",
      value: {
        schedules: expect.arrayContaining([
          expect.objectContaining({
            setBy: "agent",
            openLoopIds: [note.noteId],
          }),
        ]),
      },
    });
  });
});

describe("a Schedule set in an owner message Turn", () => {
  it("stores setBy owner, with its Open Loop links, when the Owner asked for it", async () => {
    const ownerId = await ownerInWarsaw(9706);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([
      {
        ...followUpCall([note.noteId]),
        input: {
          ...followUpCall([note.noteId]).input,
          ownerAskedForSchedule: true,
        },
      },
      { say: "Set" },
    ]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9706, text: "check on that gift for me" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    expect(await schedulesOf(ownerId)).toEqual([
      expect.objectContaining({ set_by: "owner" }),
    ]);
    expect(await linksOf(ownerId)).toHaveLength(1);
  });

  it("stores setBy agent for a follow-up that the Owner did not ask for", async () => {
    const ownerId = await ownerInWarsaw(9710);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([followUpCall([note.noteId]), { say: "Kept" }]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9710, text: "gift for Ana is due Friday" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    expect(await schedulesOf(ownerId)).toEqual([
      expect.objectContaining({ set_by: "agent", action: "run_prompt" }),
    ]);
  });

  it("stores setBy owner when the call has no Open Loop ids", async () => {
    const ownerId = await ownerInWarsaw(9711);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          action: { _tag: "RunPrompt", prompt: followUpPrompt },
          localDueTime: "2099-01-01T09:00",
        },
      },
      { say: "Set" },
    ]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9711, text: "every day check on the gift" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    expect(await schedulesOf(ownerId)).toEqual([
      expect.objectContaining({ set_by: "owner" }),
    ]);
  });
});

describe("the limit of active agent Schedules", () => {
  it("refuses a new agent Schedule at the limit with a message for the model", async () => {
    const ownerId = await ownerInWarsaw(9707);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await seedAgentSchedules(ownerId, maxActiveAgentSchedules - 1);
    scriptModel([followUpCall([note.noteId]), { say: "Good morning" }]);

    await briefFires(ownerId, 1);

    expect(lastToolResultOf(setScheduleToolName)).toMatchObject({
      type: "error-text",
      value: expect.stringContaining(
        `${maxActiveAgentSchedules} active Schedules`
      ),
    });
    const rows = await schedulesOf(ownerId);
    expect(rows.filter((row) => row.text === followUpPrompt)).toEqual([]);
  });

  it("does not count Scheduled Tasks that the Owner set", async () => {
    const ownerId = await ownerInWarsaw(9708);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await inAgent(
      ownerId,
      Effect.gen(function* seedOwnerTasks() {
        const schedules = yield* Schedules;
        const now = yield* DateTime.now;
        for (let index = 0; index < maxActiveScheduledTasks; index += 1) {
          yield* schedules.set({
            action: { _tag: "RunPrompt", prompt: `Task ${index}` },
            setBy: "owner",
            dueAt: DateTime.add(now, { days: 30 + index }),
            sourceEventId: `seed-owner-${index}`,
          });
        }
      })
    );
    scriptModel([followUpCall([note.noteId]), { say: "Good morning" }]);

    await briefFires(ownerId, 1);

    const rows = await schedulesOf(ownerId);
    expect(rows.filter((row) => row.text === followUpPrompt)).toHaveLength(1);
  });
});

describe("a follow-up that fires", () => {
  it("runs as a proactive Turn and sends one message with a Proactive Message row", async () => {
    const ownerId = await ownerInWarsaw(9709);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await keepOpenLoop(ownerId, "Renew the passport");
    scriptModel([followUpCall([note.noteId]), { say: "Good morning" }]);
    await briefFires(ownerId, 1);
    scriptModel([{ say: "Did you buy the gift for Ana?" }]);

    await makeAgentSchedulesDue(ownerId, followUpPrompt);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));
    expect(fakeTelegram.sent[2]?.body.text).toBe(
      "Did you buy the gift for Ana?"
    );
    const rows = await runInDurableObject(await agentOf(ownerId), (_, state) =>
      state.storage.sql
        .exec(
          "SELECT event_id, open_loop_ids FROM proactive_messages ORDER BY planned_at"
        )
        .toArray()
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.open_loop_ids).toBe(JSON.stringify([note.noteId]));
    const system = fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.find((message) => message.role === "system");
    expect(system?.content).toContain("The Owner is not present.");
    expect(system?.content).not.toContain("Renew the passport");
  });

  it("is held in Quiet Hours with no model call", async () => {
    const ownerId = await ownerInWarsaw(9714);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([followUpCall([note.noteId]), { say: "Good morning" }]);
    await briefFires(ownerId, 1);
    const now = DateTime.nowUnsafe();
    await inAgent(
      ownerId,
      OwnerPreferences.pipe(
        Effect.flatMap((preferences) =>
          preferences.setQuietHours(
            {
              start: localClock(DateTime.subtract(now, { hours: 1 })),
              end: localClock(DateTime.add(now, { hours: 1 })),
            },
            { start: "22:00", end: "08:00" },
            "test-setup"
          )
        )
      )
    );
    const callsBefore = fakeModel.doGenerateCalls.length;

    await makeAgentSchedulesDue(ownerId, followUpPrompt);

    await vi.waitFor(async () => {
      const [stored] = await schedulesOf(ownerId);
      expect(
        DateTime.isGreaterThan(
          DateTime.makeUnsafe(stored?.next_due_at ?? ""),
          DateTime.nowUnsafe()
        )
      ).toBe(true);
    });
    expect(fakeModel.doGenerateCalls.length).toBe(callsBefore);
    expect(fakeTelegram.sent).toHaveLength(2);
  });

  it("shows the recent Outcomes of its Open Loop", async () => {
    const ownerId = await ownerInWarsaw(9715);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    scriptModel([followUpCall([note.noteId]), { say: "Good morning" }]);
    await briefFires(ownerId, 1);
    await runInDurableObject(
      await agentOf(ownerId),
      async (instance, state) => {
        state.storage.sql.exec(
          "UPDATE proactive_messages SET window_ends_at = '2000-01-01T00:00:00.000Z'"
        );
        await instance.fireDueSchedules();
      }
    );
    scriptModel([{ say: "Did you buy the gift for Ana?" }]);

    await makeAgentSchedulesDue(ownerId, followUpPrompt);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));
    const system = fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.find((message) => message.role === "system");
    expect(system?.content).toContain(
      "recent Outcomes of earlier Proactive Messages about it, newest first: ignored"
    );
  });
});
