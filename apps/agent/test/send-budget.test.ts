import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { proactiveMessageBudgetToolName } from "../src/preferences/proactive-message-budget-tool.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const zone = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");
const followUpPrompt = "Check on the gift for Ana";

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  state: string;
  set_by: string;
  text: string | null;
}

interface PreferenceRow extends Record<string, SqlStorageValue> {
  key: string;
  value: string;
  source: string;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    Journal | Notes | OwnerPreferences | Schedules | TurnTraces
  >
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const sqlIn = async <Row extends Record<string, SqlStorageValue>>(
  ownerId: string,
  query: string,
  ...bindings: SqlStorageValue[]
) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<Row>(query, ...bindings).toArray()
  );

const journalOf = async (ownerId: string) => {
  const entries = await inAgent(
    ownerId,
    Journal.pipe(Effect.flatMap((journal) => journal.read))
  );
  return entries.map((entry) => entry.record);
};

const tracesOf = async (ownerId: string) => {
  const stored = await inAgent(
    ownerId,
    TurnTraces.pipe(Effect.flatMap((traces) => traces.read))
  );
  return stored.map(({ trace }) => trace);
};

const localClock = (instant: DateTime.Utc) => {
  const { hour, minute } = DateTime.toParts(DateTime.setZone(instant, zone));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const ownerOutsideQuietHours = async (ownerId: string) => {
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
};

const ownerWithBrief = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  scriptModel([
    { callTool: setTimeZoneToolName, input: { timeZone: "Europe/Warsaw" } },
    { say: "Done" },
  ]);
  await telegramWebhook(
    textUpdate({ fromUserId: telegramUserId, text: "I live in Warsaw" })
  );
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  await ownerOutsideQuietHours(ownerId);
  return ownerId;
};

const seedSentMessages = async (ownerId: string, count: number) => {
  const sentAt = DateTime.formatIso(DateTime.nowUnsafe());
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      sqlIn(
        ownerId,
        "INSERT INTO proactive_messages (event_id, sent_message_id, open_loop_ids, planned_at, sent_at, window_ends_at) VALUES (?, ?, '[]', ?, ?, ?)",
        `seeded-${index}`,
        `message-${index}`,
        sentAt,
        sentAt,
        sentAt
      )
    )
  );
};

const seedProactiveTokens = async (ownerId: string, tokens: number) => {
  await sqlIn(
    ownerId,
    "INSERT INTO model_usage (owner_id, recorded_at, task, model_id, input_tokens, output_tokens) VALUES (?, ?, 'proactive', 'seeded', ?, 0)",
    ownerId,
    DateTime.formatIso(DateTime.nowUnsafe()),
    tokens
  );
};

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

const addFollowUp = async (
  ownerId: string,
  sourceEventId: string,
  openLoopIds: readonly string[] = []
) => {
  await inAgent(
    ownerId,
    Schedules.pipe(
      Effect.flatMap((schedules) =>
        schedules.set({
          action: { _tag: "RunPrompt", prompt: followUpPrompt },
          setBy: "agent",
          dueAt: DateTime.add(DateTime.nowUnsafe(), { hours: 5 }),
          sourceEventId,
          openLoopIds,
        })
      )
    )
  );
};

const fireFollowUp = async (ownerId: string) => {
  await sqlIn(
    ownerId,
    "UPDATE schedules SET next_due_at = ? WHERE text = ?",
    DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })),
    followUpPrompt
  );
  await runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );
};

const followUpRow = async (ownerId: string) => {
  const [row] = await sqlIn<ScheduleRow>(
    ownerId,
    "SELECT schedule_id, state, set_by, text FROM schedules WHERE text = ?",
    followUpPrompt
  );
  return row;
};

const followUpState = async (ownerId: string) => {
  const row = await followUpRow(ownerId);
  return row?.state;
};

const journalEntriesOf = async (ownerId: string, tag: string) => {
  const records = await journalOf(ownerId);
  return records.filter((record) => record._tag === tag);
};

const foldTraces = async (ownerId: string) => {
  const traces = await tracesOf(ownerId);
  return traces.filter((trace) => trace.task === "proactive_fold");
};

const modelCalls = () => fakeModel.doGenerateCalls.length;

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  resetFakes();
});

describe("a follow-up over the send Budget", () => {
  it("makes no model call, folds into the next Brief, and writes the Journal Entry and the Trace", async () => {
    const ownerId = await ownerWithBrief(9801);
    await seedSentMessages(ownerId, 3);
    await addFollowUp(ownerId, "follow-up-1");
    const callsBefore = modelCalls();

    await fireFollowUp(ownerId);

    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );
    expect(modelCalls()).toBe(callsBefore);
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await foldTraces(ownerId)).toMatchObject([
      {
        result: "proactive_message_folded",
        reason: "message_budget",
        budget: 3,
        used: 3,
      },
    ]);
    expect(
      await journalEntriesOf(ownerId, "ProactiveMessageFolded")
    ).toHaveLength(1);
  });

  it("gives the folded follow-up to the next Brief Turn, and the Brief runs at the Budget", async () => {
    const ownerId = await ownerWithBrief(9802);
    await seedSentMessages(ownerId, 3);
    const note = await keepOpenLoop(ownerId, "Pick up the cake for Tom");
    await addFollowUp(ownerId, "follow-up-2", [note.noteId]);
    await fireFollowUp(ownerId);
    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );
    scriptModel([{ say: "Good morning, one more thing about Ana" }]);
    const callsBefore = modelCalls();

    await sqlIn(
      ownerId,
      "UPDATE schedules SET next_due_at = ? WHERE state = 'active' AND set_by = 'agent'",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      )
    );
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(modelCalls()).toBe(callsBefore + 1);
    expect(JSON.stringify(fakeModel.doGenerateCalls.at(-1)?.prompt)).toContain(
      "Pick up the cake for Tom"
    );
  });

  it("is skipped and recorded when the Brief was cancelled", async () => {
    const ownerId = await ownerWithBrief(9803);
    await sqlIn(
      ownerId,
      "UPDATE schedules SET state = 'cancelled' WHERE set_by = 'agent'"
    );
    await seedSentMessages(ownerId, 3);
    await addFollowUp(ownerId, "follow-up-3");

    await fireFollowUp(ownerId);

    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );
    expect(await foldTraces(ownerId)).toMatchObject([
      { result: "proactive_message_skipped" },
    ]);
    expect(
      await journalEntriesOf(ownerId, "ProactiveMessageSkipped")
    ).toHaveLength(1);
    expect(await journalEntriesOf(ownerId, "ProactiveMessageFolded")).toEqual(
      []
    );
  });

  it("is sent when the Budget is not used up", async () => {
    const ownerId = await ownerWithBrief(9804);
    await seedSentMessages(ownerId, 2);
    await addFollowUp(ownerId, "follow-up-4");
    scriptModel([{ say: "How is the gift for Ana?" }]);

    await fireFollowUp(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(await foldTraces(ownerId)).toEqual([]);
  });
});

describe("a follow-up that names Open Loops", () => {
  it("folds with the Open Loop ids of its Schedule", async () => {
    const ownerId = await ownerWithBrief(9811);
    await seedSentMessages(ownerId, 3);
    const note = await keepOpenLoop(ownerId, "Pick up the cake for Tom");
    await addFollowUp(ownerId, "follow-up-linked", [note.noteId]);

    await fireFollowUp(ownerId);

    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );
    expect(
      await journalEntriesOf(ownerId, "ProactiveMessageFolded")
    ).toMatchObject([{ openLoopIds: [note.noteId], reason: "message_budget" }]);
  });
});

describe("a muted follow-up", () => {
  it("is skipped and recorded with the reason muted when no Brief is active", async () => {
    const ownerId = await ownerWithBrief(9814);
    const note = await keepOpenLoop(ownerId, "Pick up the cake for Tom");
    await inAgent(
      ownerId,
      OwnerPreferences.pipe(
        Effect.flatMap((preferences) =>
          preferences.changeProactiveMutes(
            {
              change: "muted",
              targets: { openLoopIds: [note.noteId], kinds: [] },
            },
            "test-mute"
          )
        )
      )
    );
    await sqlIn(
      ownerId,
      "UPDATE schedules SET state = 'cancelled' WHERE set_by = 'agent'"
    );
    await addFollowUp(ownerId, "follow-up-muted", [note.noteId]);

    await fireFollowUp(ownerId);

    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );
    expect(await foldTraces(ownerId)).toMatchObject([
      { result: "proactive_message_skipped", reason: "muted" },
    ]);
  });
});

describe("a follow-up over proactiveDailyTokenBudget", () => {
  it("folds with no model call and leaves the Scheduled Task Budget alone", async () => {
    const ownerId = await ownerWithBrief(9805);
    await seedProactiveTokens(ownerId, 200_000);
    await addFollowUp(ownerId, "follow-up-5");
    const callsBefore = modelCalls();

    await fireFollowUp(ownerId);

    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );
    expect(modelCalls()).toBe(callsBefore);
    expect(await foldTraces(ownerId)).toMatchObject([
      {
        result: "proactive_message_folded",
        reason: "token_budget",
        budget: 200_000,
        used: 200_000,
      },
    ]);
    const traces = await tracesOf(ownerId);
    expect(
      traces.filter((trace) => trace.result === "scheduled_task_skipped")
    ).toEqual([]);
  });

  it("still runs the Brief", async () => {
    const ownerId = await ownerWithBrief(9806);
    await seedProactiveTokens(ownerId, 300_000);
    scriptModel([{ say: "Good morning" }]);
    await sqlIn(
      ownerId,
      "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent'",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      )
    );

    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(fakeTelegram.sent[1]?.body.text).toBe("Good morning");
  });
});

describe("a second alarm run after a fold", () => {
  it("adds no second fold, Trace, or Journal Entry", async () => {
    const ownerId = await ownerWithBrief(9807);
    await seedSentMessages(ownerId, 3);
    await addFollowUp(ownerId, "follow-up-6");
    await fireFollowUp(ownerId);
    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );

    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );

    expect(await foldTraces(ownerId)).toHaveLength(1);
    expect(
      await journalEntriesOf(ownerId, "ProactiveMessageFolded")
    ).toHaveLength(1);
  });
});

describe("the Budget as an Owner Preference", () => {
  it("is changed in the chat and stored with the source owner", async () => {
    const ownerId = await ownerWithBrief(9808);
    scriptModel([
      { callTool: proactiveMessageBudgetToolName, input: { sends: 2 } },
      { say: "Two a day at most" },
    ]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9808, text: "Message me twice a day at most" })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const rows = await sqlIn<PreferenceRow>(
      ownerId,
      "SELECT key, value, source FROM owner_preferences WHERE key = 'proactive_message_budget'"
    );
    expect(rows).toEqual([
      { key: "proactive_message_budget", value: "2", source: "owner" },
    ]);
  });

  it("folds a follow-up at the new Budget", async () => {
    const ownerId = await ownerWithBrief(9809);
    await sqlIn(
      ownerId,
      "INSERT INTO owner_preferences (key, value, source, source_event_id, changed_at) VALUES ('proactive_message_budget', '1', 'owner', 'seed', ?)",
      DateTime.formatIso(DateTime.nowUnsafe())
    );
    await seedSentMessages(ownerId, 1);
    await addFollowUp(ownerId, "follow-up-7");

    await fireFollowUp(ownerId);

    await vi.waitFor(async () =>
      expect(await foldTraces(ownerId)).toMatchObject([
        { reason: "message_budget", budget: 1, used: 1 },
      ])
    );
  });
});

describe("a Brief that fails", () => {
  it("leaves the folded Open Loop for a later Brief", async () => {
    const ownerId = await ownerWithBrief(9810);
    await seedSentMessages(ownerId, 3);
    const note = await keepOpenLoop(ownerId, "Pick up the cake for Tom");
    await addFollowUp(ownerId, "follow-up-8", [note.noteId]);
    await fireFollowUp(ownerId);
    await vi.waitFor(async () =>
      expect(await followUpState(ownerId)).toBe("done")
    );
    scriptModel([
      { error: "The model is down" },
      { error: "The model is down" },
      { error: "The model is down" },
    ]);
    const makeBriefDue = () =>
      sqlIn(
        ownerId,
        "UPDATE schedules SET next_due_at = ? WHERE state = 'active' AND set_by = 'agent'",
        DateTime.formatIso(
          DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
        )
      );
    await makeBriefDue();
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );
    await vi.waitFor(async () => {
      const traces = await tracesOf(ownerId);
      expect(
        traces.filter((trace) => trace.result === "proactive_message_failed")
      ).toHaveLength(1);
    }, 20_000);
    scriptModel([{ say: "Good morning" }]);

    await makeBriefDue();
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(JSON.stringify(fakeModel.doGenerateCalls.at(-1)?.prompt)).toContain(
      "Pick up the cake for Tom"
    );
  });
});
