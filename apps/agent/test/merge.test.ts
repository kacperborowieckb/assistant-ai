import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const zone = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");
const followUpPrefix = "Follow-up";

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  state: string;
  text: string | null;
  next_due_at: string;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    Journal | Notes | OwnerPreferences | Schedules | TurnTraces | Inbox
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

const localClock = (instant: DateTime.Utc) => {
  const { hour, minute } = DateTime.toParts(DateTime.setZone(instant, zone));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const storeQuietHours = async (
  ownerId: string,
  startHours: number,
  endHours: number
) => {
  const now = DateTime.nowUnsafe();
  await inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setQuietHours(
          {
            start: localClock(DateTime.add(now, { hours: startHours })),
            end: localClock(DateTime.add(now, { hours: endHours })),
          },
          { start: "22:00", end: "08:00" },
          "test-setup"
        )
      )
    )
  );
};

const minutesFromNow = (minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { minutes }));

const moveBrief = (ownerId: string, minutes: number) =>
  sqlIn(
    ownerId,
    "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent' AND text NOT LIKE ?",
    minutesFromNow(minutes),
    `${followUpPrefix}%`
  );

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
  await storeQuietHours(ownerId, 2, 3);
  await moveBrief(ownerId, 5 * 60);
  return ownerId;
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

interface FollowUpPlan {
  readonly name: string;
  readonly dueInMinutes: number;
  readonly openLoopIds?: readonly string[];
}

const addFollowUp = (
  ownerId: string,
  { name, dueInMinutes, openLoopIds = [] }: FollowUpPlan
) =>
  inAgent(
    ownerId,
    Schedules.pipe(
      Effect.flatMap((schedules) =>
        schedules.set({
          action: { _tag: "RunPrompt", prompt: `${followUpPrefix} ${name}` },
          setBy: "agent",
          dueAt: DateTime.add(DateTime.nowUnsafe(), {
            minutes: dueInMinutes,
          }),
          sourceEventId: `source-${name}`,
          openLoopIds,
        })
      )
    )
  );

const fireAlarm = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );

const makeDue = (ownerId: string, name: string) =>
  sqlIn(
    ownerId,
    "UPDATE schedules SET next_due_at = ? WHERE text = ?",
    DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })),
    `${followUpPrefix} ${name}`
  );

const stateOf = async (ownerId: string, name: string) => {
  const row = await scheduleNamed(ownerId, name);
  return row?.state;
};

const scheduleNamed = async (ownerId: string, name: string) => {
  const [row] = await sqlIn<ScheduleRow>(
    ownerId,
    "SELECT schedule_id, state, text, next_due_at FROM schedules WHERE text = ?",
    `${followUpPrefix} ${name}`
  );
  return row;
};

const journalTagged = async (ownerId: string, tag: string) => {
  const entries = await inAgent(
    ownerId,
    Journal.pipe(Effect.flatMap((journal) => journal.read))
  );
  return entries.filter(({ record }) => record._tag === tag);
};

const foldTraces = async (ownerId: string) => {
  const stored = await inAgent(
    ownerId,
    TurnTraces.pipe(Effect.flatMap((traces) => traces.read))
  );
  return stored.flatMap(({ trace }) =>
    trace.task === "proactive_fold" ? [trace] : []
  );
};

const sentRowsOf = (ownerId: string) =>
  sqlIn(
    ownerId,
    "SELECT event_id FROM proactive_messages WHERE sent_at IS NOT NULL"
  );

const modelCalls = () => fakeModel.doGenerateCalls.length;

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  resetFakes();
});

describe("follow-ups that are due close together", () => {
  it("run as one Turn with one message, and both Schedules complete", async () => {
    const ownerId = await ownerWithBrief(9901);
    const cake = await keepOpenLoop(ownerId, "Pick up the cake for Tom");
    const gift = await keepOpenLoop(ownerId, "Buy the gift for Ana");
    await addFollowUp(ownerId, {
      name: "cake",
      dueInMinutes: 0,
      openLoopIds: [cake.noteId],
    });
    await addFollowUp(ownerId, {
      name: "gift",
      dueInMinutes: 10,
      openLoopIds: [gift.noteId],
    });
    scriptModel([{ say: "The cake and the gift" }]);
    const callsBefore = modelCalls();

    await makeDue(ownerId, "cake");
    await fireAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await stateOf(ownerId, "gift")).toBe("done")
    );
    expect(fakeTelegram.sent).toHaveLength(2);
    expect(modelCalls()).toBe(callsBefore + 1);
    const prompt = JSON.stringify(fakeModel.doGenerateCalls.at(-1)?.prompt);
    expect(prompt).toContain("Pick up the cake for Tom");
    expect(prompt).toContain("Buy the gift for Ana");
    expect(prompt).toContain("Follow-up gift");
    expect(await stateOf(ownerId, "cake")).toBe("done");
    expect(await journalTagged(ownerId, "ProactiveMessageMerged")).toHaveLength(
      1
    );
  });

  it("send two messages when the third Schedule is outside the merge window", async () => {
    const ownerId = await ownerWithBrief(9902);
    await addFollowUp(ownerId, { name: "first", dueInMinutes: 0 });
    await addFollowUp(ownerId, { name: "second", dueInMinutes: 10 });
    await addFollowUp(ownerId, { name: "third", dueInMinutes: 40 });
    scriptModel([{ say: "First and second" }, { say: "Third" }]);

    await makeDue(ownerId, "first");
    await fireAlarm(ownerId);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    await makeDue(ownerId, "third");
    await fireAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));
    expect(await stateOf(ownerId, "second")).toBe("done");
    expect(await stateOf(ownerId, "third")).toBe("done");
  });

  it("count as one send for the Budget", async () => {
    const ownerId = await ownerWithBrief(9903);
    await addFollowUp(ownerId, { name: "one", dueInMinutes: 0 });
    await addFollowUp(ownerId, { name: "two", dueInMinutes: 5 });
    await addFollowUp(ownerId, { name: "three", dueInMinutes: 10 });
    scriptModel([{ say: "One, two, and three" }]);

    await makeDue(ownerId, "one");
    await fireAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    await vi.waitFor(async () =>
      expect(await stateOf(ownerId, "three")).toBe("done")
    );
    expect(await sentRowsOf(ownerId)).toHaveLength(1);
  });

  it("move a repeating Schedule to its next occurrence", async () => {
    const ownerId = await ownerWithBrief(9904);
    const dueAt = DateTime.add(DateTime.nowUnsafe(), { minutes: 10 });
    await addFollowUp(ownerId, { name: "lead", dueInMinutes: 0 });
    await inAgent(
      ownerId,
      Schedules.pipe(
        Effect.flatMap((schedules) =>
          schedules.set({
            action: { _tag: "RunPrompt", prompt: `${followUpPrefix} daily` },
            setBy: "agent",
            dueAt,
            repeat: {
              rule: { _tag: "Daily", time: localClock(dueAt) },
              timeZone: zone,
            },
            sourceEventId: "source-daily",
            openLoopIds: [],
          })
        )
      )
    );
    scriptModel([{ say: "Both" }]);

    await makeDue(ownerId, "lead");
    await fireAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await stateOf(ownerId, "lead")).toBe("done")
    );
    const daily = await scheduleNamed(ownerId, "daily");
    expect(daily?.state).toBe("active");
    expect(
      DateTime.isGreaterThan(
        DateTime.makeUnsafe(daily?.next_due_at ?? ""),
        DateTime.add(DateTime.nowUnsafe(), { hours: 23 })
      )
    ).toBe(true);
  });
});

describe("a follow-up that is due shortly before the Brief", () => {
  it("folds into the Brief and makes no model call", async () => {
    const ownerId = await ownerWithBrief(9910);
    const note = await keepOpenLoop(ownerId, "Pick up the cake for Tom");
    await addFollowUp(ownerId, {
      name: "early",
      dueInMinutes: 0,
      openLoopIds: [note.noteId],
    });
    await moveBrief(ownerId, 20);
    const callsBefore = modelCalls();

    await makeDue(ownerId, "early");
    await fireAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await stateOf(ownerId, "early")).toBe("done")
    );
    expect(modelCalls()).toBe(callsBefore);
    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await foldTraces(ownerId)).toMatchObject([
      { result: "proactive_message_folded", reason: "brief_soon" },
    ]);
  });

  it("is taken by the Brief when the Brief fires first", async () => {
    const ownerId = await ownerWithBrief(9911);
    const note = await keepOpenLoop(ownerId, "Pick up the cake for Tom");
    await addFollowUp(ownerId, {
      name: "late",
      dueInMinutes: 20,
      openLoopIds: [note.noteId],
    });
    await sqlIn(
      ownerId,
      "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent' AND text NOT LIKE ?",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      ),
      `${followUpPrefix}%`
    );
    scriptModel([{ say: "Good morning, and the cake" }]);

    await fireAlarm(ownerId);

    await vi.waitFor(async () =>
      expect(await stateOf(ownerId, "late")).toBe("done")
    );
    expect(fakeTelegram.sent).toHaveLength(2);
    expect(JSON.stringify(fakeModel.doGenerateCalls.at(-1)?.prompt)).toContain(
      "Pick up the cake for Tom"
    );
  });
});

describe("follow-ups held by Quiet Hours", () => {
  it("merge into one message at the end of Quiet Hours", async () => {
    const ownerId = await ownerWithBrief(9920);
    await storeQuietHours(ownerId, -1, 1);
    await addFollowUp(ownerId, { name: "night-a", dueInMinutes: 0 });
    await addFollowUp(ownerId, { name: "night-b", dueInMinutes: 0 });
    await makeDue(ownerId, "night-a");
    await makeDue(ownerId, "night-b");

    await fireAlarm(ownerId);
    await vi.waitFor(async () =>
      expect(await journalTagged(ownerId, "ProactiveMessageHeld")).toHaveLength(
        2
      )
    );
    expect(fakeTelegram.sent).toHaveLength(1);

    await storeQuietHours(ownerId, 2, 3);
    await makeDue(ownerId, "night-a");
    await makeDue(ownerId, "night-b");
    scriptModel([{ say: "Both of them" }]);
    await fireAlarm(ownerId);

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    await vi.waitFor(async () => {
      expect(await stateOf(ownerId, "night-a")).toBe("done");
      expect(await stateOf(ownerId, "night-b")).toBe("done");
    });
    expect(await sentRowsOf(ownerId)).toHaveLength(1);
  });
});

describe("a merge that repeats", () => {
  it("sends once when the alarm runs twice", async () => {
    const ownerId = await ownerWithBrief(9930);
    await addFollowUp(ownerId, { name: "twice-a", dueInMinutes: 0 });
    await addFollowUp(ownerId, { name: "twice-b", dueInMinutes: 5 });
    scriptModel([{ say: "Both" }, { say: "Again" }]);

    await makeDue(ownerId, "twice-a");
    await Promise.all([fireAlarm(ownerId), fireAlarm(ownerId)]);

    await vi.waitFor(async () =>
      expect(await stateOf(ownerId, "twice-b")).toBe("done")
    );
    await fireAlarm(ownerId);
    expect(fakeTelegram.sent).toHaveLength(2);
    expect(await sentRowsOf(ownerId)).toHaveLength(1);
  });

  it("completes each merged Schedule once after a reset that follows the confirmed send", async () => {
    const ownerId = await ownerWithBrief(9931);
    await addFollowUp(ownerId, { name: "reset-a", dueInMinutes: 0 });
    await addFollowUp(ownerId, { name: "reset-b", dueInMinutes: 5 });
    await makeDue(ownerId, "reset-a");
    const eventId = await inAgent(
      ownerId,
      Effect.gen(function* seedEffect() {
        const inbox = yield* Inbox;
        const journal = yield* Journal;
        const schedules = yield* Schedules;
        yield* storeDueScheduleEvents;
        const [event] = yield* inbox.pending;
        const due = yield* schedules.activeAgentDueBy(
          DateTime.add(DateTime.nowUnsafe(), { minutes: 30 })
        );
        const merged = due.filter(
          ({ action }) =>
            action._tag === "RunPrompt" &&
            action.prompt === `${followUpPrefix} reset-b`
        );
        yield* journal.append({
          _tag: "ProactiveMessageMerged",
          eventId: event?.eventId ?? "",
          merged: merged.map(({ scheduleId, nextDueAt }) => ({
            scheduleId,
            dueAt: DateTime.formatIso(nextDueAt),
          })),
        });
        yield* journal.append({
          _tag: "ReplyPlanned",
          eventId: event?.eventId ?? "",
          text: "Both",
        });
        yield* journal.append({
          _tag: "SendStarted",
          eventId: event?.eventId ?? "",
        });
        yield* journal.append({
          _tag: "ReplySent",
          eventId: event?.eventId ?? "",
          channelMessageId: "9777",
        });
        return event?.eventId ?? "";
      })
    );
    await abortAllDurableObjects();

    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.runTurn()
    );

    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await stateOf(ownerId, "reset-a")).toBe("done");
    expect(await stateOf(ownerId, "reset-b")).toBe("done");
    const completions = await journalTagged(ownerId, "ScheduleCompleted");
    expect(
      completions.filter(
        ({ record }) =>
          record._tag === "ScheduleCompleted" && record.eventId === eventId
      )
    ).toHaveLength(2);
  });
});
