import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { quietHoursToolName } from "../src/preferences/quiet-hours-tool.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const zone = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  action: string;
  set_by: string;
  state: string;
  recurrence: string | null;
  next_due_at: string;
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
    Inbox | Journal | OwnerPreferences | Schedules | TurnTraces
  >
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const schedulesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ScheduleRow>(
        "SELECT schedule_id, action, set_by, state, recurrence, next_due_at FROM schedules ORDER BY created_at"
      )
      .toArray()
  );

const preferencesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<PreferenceRow>("SELECT key, value, source FROM owner_preferences")
      .toArray()
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

const quietHoursAroundNow = (hoursBefore: number, hoursAfter: number) => {
  const now = DateTime.nowUnsafe();
  return {
    start: localClock(DateTime.subtract(now, { hours: hoursBefore })),
    end: localClock(DateTime.add(now, { hours: hoursAfter })),
  };
};

const ownerStoresQuietHours = (
  ownerId: string,
  quietHours: { start: string; end: string }
) =>
  inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setQuietHours(
          quietHours,
          { start: "22:00", end: "08:00" },
          "test-setup"
        )
      )
    )
  );

const ownerWithBrief = async (telegramUserId: number) => {
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
  return ownerId;
};

const makeDue = async (ownerId: string, where: string) =>
  runInDurableObject(await agentOf(ownerId), (instance, state) => {
    state.storage.sql.exec(
      `UPDATE schedules SET next_due_at = ? WHERE ${where}`,
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      )
    );
    return instance.fireDueSchedules();
  });

const agentScheduleOf = async (ownerId: string) => {
  const [brief] = await schedulesOf(ownerId);
  return brief?.schedule_id ?? "";
};

const firstScheduleDueAt = async (ownerId: string) => {
  const [first] = await schedulesOf(ownerId);
  return first?.next_due_at ?? "";
};

const heldTracesOf = async (ownerId: string) => {
  const traces = await tracesOf(ownerId);
  return traces.filter((trace) => trace.result === "proactive_message_held");
};

const heldEntriesOf = async (ownerId: string) => {
  const records = await journalOf(ownerId);
  return records.flatMap((record) =>
    record._tag === "ProactiveMessageHeld" ? [record] : []
  );
};

const modelCalls = () => fakeModel.doGenerateCalls.length;

beforeEach(() => {
  resetFakes();
});

describe("an agent-set Schedule that fires in Quiet Hours", () => {
  it("makes no model call, moves to the end of Quiet Hours, and writes the Journal Entry and the Trace", async () => {
    const ownerId = await ownerWithBrief(9701);
    const quietHours = quietHoursAroundNow(1, 1);
    await ownerStoresQuietHours(ownerId, quietHours);
    const callsBefore = modelCalls();
    const scheduleId = await agentScheduleOf(ownerId);

    await makeDue(ownerId, "set_by = 'agent'");

    await vi.waitFor(async () =>
      expect(await firstScheduleDueAt(ownerId)).toSatisfy((dueAt: string) =>
        DateTime.isGreaterThan(DateTime.makeUnsafe(dueAt), DateTime.nowUnsafe())
      )
    );
    const [row] = await schedulesOf(ownerId);
    const movedTo = DateTime.makeUnsafe(row?.next_due_at ?? "");
    expect(localClock(movedTo)).toBe(quietHours.end);
    expect(
      DateTime.toEpochMillis(movedTo) -
        DateTime.toEpochMillis(DateTime.nowUnsafe())
    ).toBeLessThan(2 * 60 * 60 * 1000);
    expect(modelCalls()).toBe(callsBefore);
    expect(fakeTelegram.sent).toHaveLength(1);
    const [held] = await heldEntriesOf(ownerId);
    expect(held).toMatchObject({
      scheduleId,
      toDueAt: DateTime.formatIso(movedTo),
      reason: "quiet_hours",
    });
    expect(held?.fromDueAt).not.toBe(held?.toDueAt);
    expect(await heldTracesOf(ownerId)).toMatchObject([
      {
        task: "proactive_hold",
        eventId: held?.eventId,
        scheduleId,
        heldUntil: held?.toDueAt,
        reason: "quiet_hours",
      },
    ]);
  });

  it("is sent once when Quiet Hours are over, and a second alarm run changes nothing", async () => {
    const ownerId = await ownerWithBrief(9702);
    await ownerStoresQuietHours(ownerId, quietHoursAroundNow(1, 1));
    await makeDue(ownerId, "set_by = 'agent'");
    await vi.waitFor(async () =>
      expect(await heldEntriesOf(ownerId)).toHaveLength(1)
    );
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );
    expect(await heldEntriesOf(ownerId)).toHaveLength(1);
    expect(fakeTelegram.sent).toHaveLength(1);
    await ownerStoresQuietHours(ownerId, quietHoursAroundNow(-2, -3));
    scriptModel([{ say: "Good morning" }]);

    await makeDue(ownerId, "set_by = 'agent'");
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.fireDueSchedules()
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(fakeTelegram.sent[1]?.body.text).toBe("Good morning");
    expect(await heldEntriesOf(ownerId)).toHaveLength(1);
  });

  it("holds once after a reset between the Journal Entry and the move of the due instant", async () => {
    const ownerId = await ownerWithBrief(9703);
    await ownerStoresQuietHours(ownerId, quietHoursAroundNow(1, 1));
    const scheduleId = await agentScheduleOf(ownerId);
    const fromDueAt = DateTime.formatIso(
      DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
    );
    const toDueAt = DateTime.formatIso(
      DateTime.add(DateTime.nowUnsafe(), { hours: 1 })
    );
    await runInDurableObject(await agentOf(ownerId), (_, state) => {
      state.storage.sql.exec(
        "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent'",
        fromDueAt
      );
    });
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const inbox = yield* Inbox;
          const journal = yield* Journal;
          yield* storeDueScheduleEvents;
          const [event] = yield* inbox.pending;
          yield* journal.append({
            _tag: "ProactiveMessageHeld",
            eventId: event?.eventId ?? "",
            scheduleId,
            fromDueAt,
            toDueAt,
            reason: "quiet_hours",
          });
        })
      )
    );
    await abortAllDurableObjects();

    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.runTurn()
    );

    const [row] = await schedulesOf(ownerId);
    expect(row?.next_due_at).toBe(toDueAt);
    expect(await heldEntriesOf(ownerId)).toHaveLength(1);
    expect(await heldTracesOf(ownerId)).toMatchObject([{ heldUntil: toDueAt }]);
    expect(fakeTelegram.sent).toHaveLength(1);
  });
});

describe("a Schedule that the Owner set", () => {
  it("sends an Owner-set Reminder in Quiet Hours at its time", async () => {
    const ownerId = await ownerWithBrief(9710);
    await ownerStoresQuietHours(ownerId, quietHoursAroundNow(1, 1));
    await inAgent(
      ownerId,
      Schedules.pipe(
        Effect.flatMap((schedules) =>
          schedules.set({
            action: { _tag: "SendText", text: "Call Ana" },
            setBy: "owner",
            dueAt: DateTime.add(DateTime.nowUnsafe(), { hours: 1 }),
            sourceEventId: "reminder-in-quiet-hours",
          })
        )
      )
    );

    await makeDue(ownerId, "set_by = 'owner'");

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
    expect(fakeTelegram.sent[1]?.body.text).toBe("Call Ana");
    expect(await heldEntriesOf(ownerId)).toHaveLength(0);
  });
});

const ownerSetsQuietHours = async (
  telegramUserId: number,
  input: Record<string, unknown>,
  sentSoFar: number
) => {
  scriptModel([{ callTool: quietHoursToolName, input }, { say: "Done" }]);
  await telegramWebhook(
    textUpdate({ fromUserId: telegramUserId, text: "quiet hours" })
  );
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sentSoFar + 1));
};

describe("the Owner changes Quiet Hours in the chat", () => {
  it("stores the value with the source owner and moves a Brief that was at the old end", async () => {
    const ownerId = await ownerWithBrief(9720);

    await ownerSetsQuietHours(9720, { start: "23:00", end: "09:30" }, 1);

    const preferences = await preferencesOf(ownerId);
    expect(preferences.find(({ key }) => key === "quiet_hours")).toEqual({
      key: "quiet_hours",
      value: JSON.stringify({ start: "23:00", end: "09:30" }),
      source: "owner",
    });
    const [brief] = await schedulesOf(ownerId);
    expect(JSON.parse(brief?.recurrence ?? "")).toEqual({
      _tag: "Daily",
      time: "09:30",
    });
    expect(localClock(DateTime.makeUnsafe(brief?.next_due_at ?? ""))).toBe(
      "09:30"
    );
  });

  it("keeps a Brief that the Owner moved to another time", async () => {
    const ownerId = await ownerWithBrief(9721);
    await runInDurableObject(await agentOf(ownerId), (_, state) => {
      state.storage.sql.exec(
        `UPDATE schedules SET recurrence = '{"_tag":"Daily","time":"07:30"}' WHERE set_by = 'agent'`
      );
    });
    const [before] = await schedulesOf(ownerId);

    await ownerSetsQuietHours(9721, { start: "23:00", end: "09:30" }, 1);

    const [after] = await schedulesOf(ownerId);
    expect(after?.recurrence).toBe(before?.recurrence);
    expect(after?.next_due_at).toBe(before?.next_due_at);
  });

  it("reads the default Quiet Hours when the Owner stored none", async () => {
    const ownerId = await ownerWithBrief(9722);

    await ownerSetsQuietHours(9722, {}, 1);

    expect(await preferencesOf(ownerId)).toMatchObject([
      { key: "time_zone", source: "owner" },
    ]);
    const output = fakeModel.doGenerateCalls
      .flatMap((call) => call.prompt)
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .map((part) => JSON.stringify(part));
    expect(output.join(" ")).toContain("22:00");
    expect(output.join(" ")).toContain("default");
  });

  it("refuses a start that equals the end and stores nothing", async () => {
    const ownerId = await ownerWithBrief(9723);

    await ownerSetsQuietHours(9723, { start: "08:00", end: "08:00" }, 1);

    const preferences = await preferencesOf(ownerId);
    expect(preferences.some(({ key }) => key === "quiet_hours")).toBe(false);
  });
});

describe("an untrusted Turn", () => {
  it("gets no Quiet Hours tool", async () => {
    await addOwner(9730);
    scriptModel([{ say: "Kept" }]);

    await telegramWebhook(
      textUpdate({
        fromUserId: 9730,
        text: "Do not message me at all",
        forwardOrigin: {
          type: "user",
          sender_user: { id: 5, is_bot: false, first_name: "Ana" },
          date: 1_794_000_000,
        },
      })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const offered = fakeModel.doGenerateCalls.flatMap(
      (call) => call.tools?.map((tool) => tool.name) ?? []
    );
    expect(offered).not.toContain(quietHoursToolName);
  });
});
