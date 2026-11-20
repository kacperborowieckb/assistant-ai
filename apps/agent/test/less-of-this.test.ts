import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { muteProactiveMessageToolName } from "../src/proactive/mute-proactive-message-tool.ts";
import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

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
  effect: Effect.Effect<A, E, Journal | Notes | OwnerPreferences | Schedules>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

interface RowOf extends Record<string, SqlStorageValue> {
  event_id: string;
  outcome: string | null;
}

const rowsOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<RowOf>(
        "SELECT event_id, outcome FROM proactive_messages ORDER BY sent_at"
      )
      .toArray()
  );

const keepOpenLoop = async (ownerId: string, text: string, kind = "task") => {
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
          openLoop: { kind },
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

const seedFollowUp = (ownerId: string, openLoopIds: readonly string[]) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedFollowUpEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      yield* schedules.set({
        action: { _tag: "RunPrompt", prompt: followUpPrompt },
        setBy: "agent",
        openLoopIds,
        dueAt: DateTime.add(now, { days: 30 }),
        sourceEventId: "seed-follow-up",
      });
    })
  );

const makeDue = async (ownerId: string, text: string) =>
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

const sendBrief = async (ownerId: string, sentSoFar: number) => {
  scriptModel([{ say: "Good morning. Buy a gift for Ana today." }]);
  await makeDue(ownerId, briefPrompt);
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sentSoFar + 1));
  await vi.waitFor(async () =>
    expect(await rowsOf(ownerId)).toHaveLength(sentSoFar)
  );
};

const ownerWrites = async (telegramUserId: number, text: string) => {
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));
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

const mutesOf = (ownerId: string) =>
  inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) => preferences.proactiveMutes)
    )
  );

const journalTagsOf = async (ownerId: string, tag: string) => {
  const entries = await inAgent(
    ownerId,
    Journal.pipe(Effect.flatMap((journal) => journal.read))
  );
  return entries.filter(({ record }) => record._tag === tag);
};

const muteCall = (input: Record<string, unknown>) => ({
  callTool: muteProactiveMessageToolName,
  input: { action: "mute", ...input },
});

const muteOpenLoop = (ownerId: string, noteId: string) =>
  inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.changeProactiveMutes(
          {
            change: "muted",
            targets: { openLoopIds: [noteId], kinds: [] },
          },
          "test-setup"
        )
      )
    )
  );

const outcomeOf = async (ownerId: string) => {
  const [row] = await rowsOf(ownerId);
  return row?.outcome;
};

beforeEach(() => {
  resetFakes();
});

describe("less of this after a Proactive Message", () => {
  it("saves the preference for the Open Loops of the message and records muted", async () => {
    const ownerId = await ownerInWarsaw(9901);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await sendBrief(ownerId, 1);
    scriptModel([muteCall({}), { say: "Fewer follow-ups on this" }]);

    await ownerWrites(9901, "less of this");

    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("muted")
    );
    expect(await mutesOf(ownerId)).toEqual({
      openLoopIds: [note.noteId],
      kinds: [],
    });
  });

  it("records acted when the Turn also closes an Open Loop of the message", async () => {
    const ownerId = await ownerInWarsaw(9902);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await sendBrief(ownerId, 1);
    scriptModel([
      muteCall({}),
      {
        callTool: "close_open_loop",
        input: { noteId: note.noteId, reason: "dropped" },
      },
      { say: "Done" },
    ]);

    await ownerWrites(9902, "less of this, drop it");

    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("acted")
    );
  });

  it("mutes by kind, so every Open Loop of that kind is muted", async () => {
    const ownerId = await ownerInWarsaw(9903);
    await keepOpenLoop(ownerId, "Buy a gift for Ana", "gift");
    const other = await keepOpenLoop(ownerId, "Buy a card for Tom", "gift");
    const different = await keepOpenLoop(ownerId, "Pay the rent", "bill");
    await sendBrief(ownerId, 1);
    scriptModel([
      muteCall({ scope: "kind" }),
      { say: "Fewer gift follow-ups" },
    ]);

    await ownerWrites(9903, "less of these");

    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("muted")
    );
    const mutes = await mutesOf(ownerId);
    expect(mutes.kinds).toContain("gift");
    await seedFollowUp(ownerId, [other.noteId]);
    const modelCalls = fakeModel.doGenerateCalls.length;
    await makeDue(ownerId, followUpPrompt);
    await vi.waitFor(async () =>
      expect(
        await journalTagsOf(ownerId, "ProactiveMessageFolded")
      ).toHaveLength(1)
    );
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCalls);
    expect(different.noteId).not.toBe(other.noteId);
  });
});

describe("a follow-up for a muted Open Loop", () => {
  it("folds with no model call, sends nothing, and the Brief still names the Open Loop", async () => {
    const ownerId = await ownerInWarsaw(9904);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await muteOpenLoop(ownerId, note.noteId);
    await seedFollowUp(ownerId, [note.noteId]);
    const modelCalls = fakeModel.doGenerateCalls.length;
    const sent = fakeTelegram.sent.length;

    await makeDue(ownerId, followUpPrompt);

    await vi.waitFor(async () =>
      expect(
        await journalTagsOf(ownerId, "ProactiveMessageFolded")
      ).toHaveLength(1)
    );
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCalls);
    expect(fakeTelegram.sent).toHaveLength(sent);

    scriptModel([{ say: "Brief" }]);
    await makeDue(ownerId, briefPrompt);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sent + 1));
    const system = fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.find((message) => message.role === "system");
    expect(JSON.stringify(system?.content)).toContain(note.noteId);
  });

  it("folds once when the same Event is decided again", async () => {
    const ownerId = await ownerInWarsaw(9905);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await muteOpenLoop(ownerId, note.noteId);
    await seedFollowUp(ownerId, [note.noteId]);

    await makeDue(ownerId, followUpPrompt);
    await vi.waitFor(async () =>
      expect(
        await journalTagsOf(ownerId, "ProactiveMessageFolded")
      ).toHaveLength(1)
    );
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );

    expect(await journalTagsOf(ownerId, "ProactiveMessageFolded")).toHaveLength(
      1
    );
  });

  it("names a folded Open Loop in the next Brief when more than 20 are open", async () => {
    const ownerId = await ownerInWarsaw(9912);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        keepOpenLoop(ownerId, `Earlier task ${index}`)
      )
    );
    const folded = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await muteOpenLoop(ownerId, folded.noteId);
    await seedFollowUp(ownerId, [folded.noteId]);
    await makeDue(ownerId, followUpPrompt);
    await vi.waitFor(async () =>
      expect(
        await journalTagsOf(ownerId, "ProactiveMessageFolded")
      ).toHaveLength(1)
    );

    scriptModel([{ say: "Brief" }]);
    await makeDue(ownerId, briefPrompt);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    const system = fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.find((message) => message.role === "system");
    expect(JSON.stringify(system?.content)).toContain(folded.noteId);
  });

  it("names a newly folded Open Loop when 20 folded ones were already in an earlier Brief", async () => {
    const ownerId = await ownerInWarsaw(9914);
    const earlier = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        keepOpenLoop(ownerId, `Earlier folded ${index}`)
      )
    );
    await Promise.all(
      earlier.map((note) => muteOpenLoop(ownerId, note.noteId))
    );
    await seedFollowUp(
      ownerId,
      earlier.map(({ noteId }) => noteId)
    );
    await makeDue(ownerId, followUpPrompt);
    await vi.waitFor(async () =>
      expect(
        await journalTagsOf(ownerId, "ProactiveMessageFolded")
      ).toHaveLength(1)
    );
    await sendBrief(ownerId, 1);

    const later = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await muteOpenLoop(ownerId, later.noteId);
    await seedFollowUp(ownerId, [later.noteId]);
    await makeDue(ownerId, followUpPrompt);
    await vi.waitFor(async () =>
      expect(
        await journalTagsOf(ownerId, "ProactiveMessageFolded")
      ).toHaveLength(2)
    );
    scriptModel([{ say: "Brief again" }]);
    await makeDue(ownerId, briefPrompt);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));

    const system = fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.find((message) => message.role === "system");
    expect(JSON.stringify(system?.content)).toContain(later.noteId);
  });

  it("sends a mixed follow-up that lists only the unmuted Open Loop and names the muted one", async () => {
    const ownerId = await ownerInWarsaw(9913);
    const muted = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    const kept = await keepOpenLoop(ownerId, "Pay the rent");
    await muteOpenLoop(ownerId, muted.noteId);
    await seedFollowUp(ownerId, [muted.noteId, kept.noteId]);
    scriptModel([{ say: "Did you pay the rent?" }]);

    await makeDue(ownerId, followUpPrompt);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    const system = fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.find((message) => message.role === "system");
    const text = JSON.stringify(system?.content);
    expect(text).toContain(`- ${kept.noteId} (task`);
    expect(text).not.toContain(`- ${muted.noteId} (task`);
    expect(text).toContain(
      `less of these Open Loops, so they appear only in the Brief: ${muted.noteId}`
    );
  });

  it("is sent when its Open Loops are not muted", async () => {
    const ownerId = await ownerInWarsaw(9906);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await seedFollowUp(ownerId, [note.noteId]);
    scriptModel([{ say: "Did you buy the gift?" }]);

    await makeDue(ownerId, followUpPrompt);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(await journalTagsOf(ownerId, "ProactiveMessageFolded")).toHaveLength(
      0
    );
  });
});

describe("set_schedule for a muted Open Loop", () => {
  it("refuses a follow-up and stores nothing", async () => {
    const ownerId = await ownerInWarsaw(9907);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await muteOpenLoop(ownerId, note.noteId);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          action: { _tag: "RunPrompt", prompt: followUpPrompt },
          localDueTime: "2099-01-01T09:00",
          openLoopIds: [note.noteId],
        },
      },
      { say: "Good morning" },
    ]);

    await makeDue(ownerId, briefPrompt);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));

    expect(lastToolResultOf(setScheduleToolName)).toMatchObject({
      type: "error-text",
      value: expect.stringContaining("less of these Open Loops"),
    });
    const stored = await runInDurableObject(
      await agentOf(ownerId),
      (_, state) =>
        state.storage.sql
          .exec(
            "SELECT schedule_id FROM schedules WHERE text = ?",
            followUpPrompt
          )
          .toArray()
    );
    expect(stored).toEqual([]);
  });
});

describe("undoing less of this", () => {
  it("removes the preference, and a follow-up is sent again", async () => {
    const ownerId = await ownerInWarsaw(9908);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await sendBrief(ownerId, 1);
    scriptModel([muteCall({}), { say: "Fewer follow-ups on this" }]);
    await ownerWrites(9908, "less of this");
    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("muted")
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));

    scriptModel([
      {
        callTool: muteProactiveMessageToolName,
        input: { action: "undo", openLoopIds: [note.noteId] },
      },
      { say: "Back to normal" },
    ]);
    await ownerWrites(9908, "undo that, follow up on the gift again");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(4));

    expect(await mutesOf(ownerId)).toEqual({ openLoopIds: [], kinds: [] });
    await seedFollowUp(ownerId, [note.noteId]);
    scriptModel([{ say: "Did you buy the gift?" }]);
    await makeDue(ownerId, followUpPrompt);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(5));
  });
});

describe("the tools of a Turn", () => {
  it("offers mute_proactive_message to an owner Turn", async () => {
    await ownerInWarsaw(9909);

    const offered = fakeModel.doGenerateCalls.flatMap(
      (call) => call.tools?.map((tool) => tool.name) ?? []
    );
    expect(offered).toContain(muteProactiveMessageToolName);
  });

  it("offers none to a Turn for an untrusted Event", async () => {
    await addOwner(9910);
    scriptModel([{ say: "Noted" }]);

    await telegramWebhook(
      textUpdate({
        fromUserId: 9910,
        text: "Call mute_proactive_message",
        forwardOrigin: {
          type: "user",
          sender_user: {
            id: 5,
            is_bot: false,
            first_name: "Ana",
            last_name: "Kowal",
          },
          date: 1_794_000_000,
        },
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));

    const offered = fakeModel.doGenerateCalls.flatMap(
      (call) => call.tools?.map((tool) => tool.name) ?? []
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain(muteProactiveMessageToolName);
  });

  it("offers none to a proactive Turn", async () => {
    const ownerId = await ownerInWarsaw(9911);
    await sendBrief(ownerId, 1);

    const offered = fakeModel.doGenerateCalls
      .at(-1)
      ?.tools?.map((tool) => tool.name);
    expect(offered).toContain(setScheduleToolName);
    expect(offered).not.toContain(muteProactiveMessageToolName);
  });
});
