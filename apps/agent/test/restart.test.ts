import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isRestartRecord, Journal } from "../src/journal/journal.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { restartSection } from "../src/personal-agent/turn-restart.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  fakeBurstWait,
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  holdModel,
  resetFakes,
  scriptModel,
  burstInputTexts,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ModelPrompt = (typeof fakeModel.doGenerateCalls)[number]["prompt"];

const quietMillis = 1500;

const ownerTextsOf = (prompt: ModelPrompt) =>
  prompt
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "text" ? [part.text] : []
      )
    );

const systemTextOf = (prompt: ModelPrompt) =>
  prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

const toolMessageCountOf = (prompt: ModelPrompt) =>
  prompt.filter((message) => message.role === "tool").length;

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Journal | TurnTraces | OwnerPreferences>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const pause = (millis: number) => scheduler.wait(millis);

const send = (telegramUserId: number, text: string, messageId: number) =>
  telegramWebhook(textUpdate({ fromUserId: telegramUserId, text, messageId }));

const fireAlarm = async (ownerId: string) =>
  runDurableObjectAlarm(await agentOf(ownerId));

const waitBurst = (quiet: number, maxWait = 60_000, maxRestarts = 2) => {
  fakeBurstWait.quietMillis = quiet;
  fakeBurstWait.maxWaitMillis = maxWait;
  fakeBurstWait.maxRestarts = maxRestarts;
};

const rowsOf = async <Row extends Record<string, SqlStorageValue>>(
  ownerId: string,
  query: string
) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<Row>(query).toArray()
  );

const eventStates = (ownerId: string) =>
  rowsOf<{ state: string }>(
    ownerId,
    "SELECT state FROM inbox_events ORDER BY sequence"
  ).then((rows) => rows.map((row) => row.state));

const eventIds = (ownerId: string) =>
  rowsOf<{ event_id: string }>(
    ownerId,
    "SELECT event_id FROM inbox_events ORDER BY sequence"
  ).then((rows) => rows.map((row) => row.event_id));

const noteTexts = (ownerId: string) =>
  rowsOf<{ text: string }>(ownerId, "SELECT text FROM notes").then((rows) =>
    rows.map((row) => row.text)
  );

const scheduleCount = (ownerId: string) =>
  rowsOf<{ total: number }>(
    ownerId,
    "SELECT COUNT(*) AS total FROM schedules"
  ).then((rows) => rows.at(0)?.total);

const journalRecords = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.read),
      Effect.map((entries) => entries.map((entry) => entry.record))
    )
  );

const journalTags = (ownerId: string) =>
  journalRecords(ownerId).then((records) =>
    records.map((record) => (isRestartRecord(record) ? "Restart" : record._tag))
  );

const countOf = (tags: readonly string[], tag: string) =>
  tags.filter((found) => found === tag).length;

const supersededCount = (ownerId: string) =>
  journalTags(ownerId).then((tags) => countOf(tags, "Restart"));

const replyTargets = () =>
  fakeTelegram.sent.map((message) => message.body.reply_parameters?.message_id);

const waitForModelCalls = (count: number) =>
  vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(count), {
    timeout: 8000,
  });

const waitForSupersede = (ownerId: string) =>
  vi.waitFor(async () => expect(await supersededCount(ownerId)).toBe(1), {
    timeout: 8000,
  });

const waitForSent = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 12_000,
  });

const allDone = (ownerId: string, count: number) =>
  vi.waitFor(
    async () =>
      expect(await eventStates(ownerId)).toEqual(
        Array.from({ length: count }, () => "done")
      ),
    { timeout: 12_000 }
  );

const keepThursday = [
  { callTool: captureNoteToolName, input: { text: "dentist on Thursday" } },
  { say: "Kept: dentist on Thursday" },
] as const;

const setZone = (ownerId: string) =>
  inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setTimeZone("Europe/Warsaw", "setup")
      )
    )
  );

const nextYear = new Date().getUTCFullYear() + 1;

const setReminder = {
  callTool: setScheduleToolName,
  input: {
    action: { _tag: "SendText", text: "Buy the gift for Ana" },
    localDueTime: `${nextYear}-03-12T09:00`,
  },
} as const;

beforeEach(() => {
  resetFakes();
});

describe(
  "A message that arrives mid-Turn restarts the Turn",
  { timeout: 40_000 },
  () => {
    it("sends nothing for the dropped answer, writes a restart record and a Trace, and gives one outcome for the whole Burst", async () => {
      const ownerId = await addOwner(14_001);
      waitBurst(quietMillis);
      const releaseModel = holdModel();

      await send(14_001, "first", 1);
      await waitForModelCalls(1);
      await send(14_001, "second", 2);
      releaseModel();
      await waitForSupersede(ownerId);

      expect(fakeTelegram.sent).toEqual([]);
      expect(await eventStates(ownerId)).toEqual(["pending", "pending"]);
      const ids = await eventIds(ownerId);
      const [turnEventId = ""] = ids;
      expect(await journalRecords(ownerId)).toContainEqual({
        _tag: "EventReceived",
        eventId: turnEventId,
        restart: { coveredEventIds: ids, newEventIds: [ids[1]] },
      });

      await waitForSent(1);
      await allDone(ownerId, 2);
      expect(replyTargets()).toEqual([2]);
      expect(fakeModel.doGenerateCalls).toHaveLength(2);
      expect(ownerTextsOf(fakeModel.doGenerateCalls[1]?.prompt ?? [])).toEqual(
        burstInputTexts("first", "second")
      );
      expect(
        systemTextOf(fakeModel.doGenerateCalls[1]?.prompt ?? [])
      ).toContain(restartSection);
      expect(
        systemTextOf(fakeModel.doGenerateCalls[0]?.prompt ?? [])
      ).not.toContain(restartSection);
      const tags = await journalTags(ownerId);
      expect(tags.slice(tags.indexOf("Restart"))).toEqual([
        "Restart",
        "AnsweredByTurn",
        "ReplyPlanned",
        "SendStarted",
        "ReplySent",
      ]);
      const traces = await inAgent(
        ownerId,
        TurnTraces.pipe(
          Effect.flatMap((store) => store.readForEvent(turnEventId))
        )
      );
      expect(traces.map(({ trace }) => trace.task)).toEqual(["reply", "reply"]);
      expect(
        traces.map(({ trace }) =>
          "restart" in trace ? trace.restart : undefined
        )
      ).toEqual([{ coveredEventIds: ids, newEventIds: [ids[1]] }, undefined]);
    });

    it("records the restart in the Operator metrics", async () => {
      const ownerId = await addOwner(14_002);
      waitBurst(quietMillis);
      const releaseModel = holdModel();

      await send(14_002, "first", 1);
      await waitForModelCalls(1);
      await send(14_002, "second", 2);
      releaseModel();
      await waitForSent(1);
      await allDone(ownerId, 2);

      const turns = fakeMetrics.dataPoints.filter(
        (point) => point.blobs?.[0] === "turn"
      );
      expect(turns.map((point) => point.blobs?.[1])).toEqual([
        "superseded",
        "replied",
      ]);
      expect(turns.map((point) => point.doubles?.at(-1))).toEqual([1, 1]);
    });

    it("does not call a write tool again for work that finished before the restart", async () => {
      const ownerId = await addOwner(14_003);
      waitBurst(quietMillis);
      scriptModel(keepThursday);
      const releaseModel = holdModel(1);

      await send(14_003, "keep: dentist on Thursday", 1);
      await waitForModelCalls(2);
      expect(await noteTexts(ownerId)).toEqual(["dentist on Thursday"]);
      await send(14_003, "and it is at 9", 2);
      releaseModel();
      await waitForSupersede(ownerId);
      await waitForSent(1);
      await allDone(ownerId, 2);

      expect(await noteTexts(ownerId)).toEqual(["dentist on Thursday"]);
      expect(fakeModel.doGenerateCalls).toHaveLength(3);
      const restarted = fakeModel.doGenerateCalls[2]?.prompt ?? [];
      expect(ownerTextsOf(restarted)).toEqual(
        burstInputTexts("keep: dentist on Thursday", "and it is at 9")
      );
      expect(toolMessageCountOf(restarted)).toBe(1);
      expect(replyTargets()).toEqual([2]);
      const tags = await journalTags(ownerId);
      expect(tags.filter((tag) => tag === "NoteCaptured")).toHaveLength(1);
    });

    it("does not set a Schedule again for work that finished before the restart", async () => {
      const ownerId = await addOwner(14_004);
      await setZone(ownerId);
      waitBurst(quietMillis);
      scriptModel([setReminder, { say: "Reminder set" }]);
      const releaseModel = holdModel(1);

      await send(14_004, "remind me on March 12 at 9", 1);
      await waitForModelCalls(2);
      expect(await scheduleCount(ownerId)).toBe(1);
      await send(14_004, "thanks", 2);
      releaseModel();
      await waitForSupersede(ownerId);
      await waitForSent(1);
      await allDone(ownerId, 2);

      expect(await scheduleCount(ownerId)).toBe(1);
      expect(countOf(await journalTags(ownerId), "ScheduleSet")).toBe(1);
      expect(replyTargets()).toEqual([2]);
    });

    it("restarts again for a message that arrives during the restarted Turn, and stops at burstMaxRestarts", async () => {
      const ownerId = await addOwner(14_005);
      waitBurst(quietMillis, 60_000, 1);
      const releaseFirst = holdModel();

      await send(14_005, "first", 1);
      await waitForModelCalls(1);
      await send(14_005, "second", 2);
      const releaseSecond = holdModel(1);
      releaseFirst();
      await waitForSupersede(ownerId);
      await waitForModelCalls(2);
      await send(14_005, "third", 3);
      releaseSecond();

      await waitForSent(2);
      await allDone(ownerId, 3);
      expect(await supersededCount(ownerId)).toBe(1);
      expect(replyTargets()).toEqual([2, 3]);
      expect(ownerTextsOf(fakeModel.doGenerateCalls[1]?.prompt ?? [])).toEqual(
        burstInputTexts("first", "second")
      );
      expect(ownerTextsOf(fakeModel.doGenerateCalls[2]?.prompt ?? [])).toEqual([
        ...burstInputTexts("first", "second"),
        "third",
      ]);
    });

    it("restarts twice by default and then sends", async () => {
      const ownerId = await addOwner(14_006);
      waitBurst(quietMillis);
      const releaseFirst = holdModel();

      await send(14_006, "first", 1);
      await waitForModelCalls(1);
      await send(14_006, "second", 2);
      const releaseSecond = holdModel(1);
      releaseFirst();
      await waitForModelCalls(2);
      await send(14_006, "third", 3);
      const releaseThird = holdModel(2);
      releaseSecond();
      await waitForModelCalls(3);
      await send(14_006, "fourth", 4);
      releaseThird();

      await waitForSent(2);
      await allDone(ownerId, 4);
      expect(countOf(await journalTags(ownerId), "Restart")).toBe(2);
      expect(replyTargets()).toEqual([3, 4]);
    });

    it("sends and does not restart once burstMaxWaitMillis has passed since the first message", async () => {
      const ownerId = await addOwner(14_007);
      waitBurst(300, 1200);
      const releaseModel = holdModel();

      await send(14_007, "first", 1);
      await waitForModelCalls(1);
      await send(14_007, "second", 2);
      await pause(1500);
      releaseModel();

      await waitForSent(2);
      await allDone(ownerId, 2);
      expect(await supersededCount(ownerId)).toBe(0);
      expect(replyTargets()).toEqual([1, 2]);
    });

    it("gives a message that arrives after the send its own Turn", async () => {
      const ownerId = await addOwner(14_008);
      waitBurst(300);

      await send(14_008, "first", 1);
      await waitForSent(1);
      await allDone(ownerId, 1);
      await send(14_008, "second", 2);
      await waitForSent(2);
      await allDone(ownerId, 2);

      expect(replyTargets()).toEqual([1, 2]);
      expect(await supersededCount(ownerId)).toBe(0);
      expect(fakeModel.doGenerateCalls).toHaveLength(2);
      expect(ownerTextsOf(fakeModel.doGenerateCalls[0]?.prompt ?? [])).toEqual([
        "first",
      ]);
    });
  }
);

describe(
  "The restart survives a Durable Object reset",
  { timeout: 40_000 },
  () => {
    it("gives one outcome when the reset comes after the second message is stored", async () => {
      const ownerId = await addOwner(14_101);
      waitBurst(quietMillis);
      const releaseModel = holdModel();

      await send(14_101, "first", 1);
      await waitForModelCalls(1);
      await send(14_101, "second", 2);
      await abortAllDurableObjects();
      releaseModel();
      await pause(quietMillis / 3);
      await fireAlarm(ownerId);
      expect(fakeTelegram.sent).toEqual([]);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);

      await waitForSent(1);
      await allDone(ownerId, 2);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);
      expect(fakeTelegram.sent).toHaveLength(1);
      expect(replyTargets()).toEqual([2]);
      expect(
        ownerTextsOf(fakeModel.doGenerateCalls.at(-1)?.prompt ?? [])
      ).toEqual(burstInputTexts("first", "second"));
    });

    it("gives one outcome and no second Note when the reset comes after a write tool finished", async () => {
      const ownerId = await addOwner(14_102);
      waitBurst(quietMillis);
      scriptModel(keepThursday);
      const releaseModel = holdModel(1);

      await send(14_102, "keep: dentist on Thursday", 1);
      await waitForModelCalls(2);
      await send(14_102, "and it is at 9", 2);
      await abortAllDurableObjects();
      releaseModel();
      await pause(quietMillis / 3);
      await fireAlarm(ownerId);
      expect(fakeTelegram.sent).toEqual([]);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);

      await waitForSent(1);
      await allDone(ownerId, 2);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);
      expect(fakeTelegram.sent).toHaveLength(1);
      expect(replyTargets()).toEqual([2]);
      expect(await noteTexts(ownerId)).toEqual(["dentist on Thursday"]);
      const restarted = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
      expect(toolMessageCountOf(restarted)).toBe(1);
    });

    it("gives one outcome and no second Schedule when the reset comes after a Schedule was set", async () => {
      const ownerId = await addOwner(14_103);
      await setZone(ownerId);
      waitBurst(quietMillis);
      scriptModel([setReminder, { say: "Reminder set" }]);
      const releaseModel = holdModel(1);

      await send(14_103, "remind me on March 12 at 9", 1);
      await waitForModelCalls(2);
      await send(14_103, "thanks", 2);
      await abortAllDurableObjects();
      releaseModel();
      await pause(quietMillis / 3);
      await fireAlarm(ownerId);
      expect(fakeTelegram.sent).toEqual([]);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);

      await waitForSent(1);
      await allDone(ownerId, 2);
      expect(fakeTelegram.sent).toHaveLength(1);
      expect(replyTargets()).toEqual([2]);
      expect(await scheduleCount(ownerId)).toBe(1);
      expect(countOf(await journalTags(ownerId), "ScheduleSet")).toBe(1);
      const restarted = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
      expect(toolMessageCountOf(restarted)).toBe(1);
    });

    it("gives one outcome when the reset comes after the restart record and before the next Turn", async () => {
      const ownerId = await addOwner(14_104);
      waitBurst(quietMillis);
      scriptModel(keepThursday);
      const releaseModel = holdModel(1);

      await send(14_104, "keep: dentist on Thursday", 1);
      await waitForModelCalls(2);
      await send(14_104, "and it is at 9", 2);
      releaseModel();
      await waitForSupersede(ownerId);
      expect(fakeTelegram.sent).toEqual([]);
      await abortAllDurableObjects();
      await pause(quietMillis / 3);
      await fireAlarm(ownerId);
      expect(fakeTelegram.sent).toEqual([]);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);

      await waitForSent(1);
      await allDone(ownerId, 2);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);
      expect(fakeTelegram.sent).toHaveLength(1);
      expect(replyTargets()).toEqual([2]);
      expect(await noteTexts(ownerId)).toEqual(["dentist on Thursday"]);
      expect(await supersededCount(ownerId)).toBe(1);
      expect(countOf(await journalTags(ownerId), "ReplySent")).toBe(1);
    });

    it("sends nothing twice when the reset comes after the send started", async () => {
      const ownerId = await addOwner(14_105);
      waitBurst(quietMillis);
      scriptModel(keepThursday);
      const releaseModel = holdModel(1);

      await send(14_105, "keep: dentist on Thursday", 1);
      await waitForModelCalls(2);
      await send(14_105, "and it is at 9", 2);
      const releaseSend = fakeTelegram.holdSends();
      releaseModel();
      await waitForSupersede(ownerId);
      await waitForSent(1);
      await abortAllDurableObjects();
      releaseSend();
      await pause(200);
      await fireAlarm(ownerId);
      await pause(quietMillis + 100);
      await fireAlarm(ownerId);

      await vi.waitFor(
        async () =>
          expect(await eventStates(ownerId)).toEqual(["failed", "failed"]),
        { timeout: 8000 }
      );
      expect(fakeTelegram.sent).toHaveLength(1);
      expect(replyTargets()).toEqual([2]);
      expect(await noteTexts(ownerId)).toEqual(["dentist on Thursday"]);
      expect(fakeModel.doGenerateCalls).toHaveLength(3);
      const tags = await journalTags(ownerId);
      expect(tags.filter((tag) => tag === "SendStarted")).toHaveLength(1);
      expect(tags.filter((tag) => tag === "Restart")).toHaveLength(1);
    });
  }
);
