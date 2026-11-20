import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import {
  fakeBurstWait,
  fakeModel,
  fakeReplyPrefix,
  fakeTelegram,
  holdModel,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ModelPrompt = (typeof fakeModel.doGenerateCalls)[number]["prompt"];

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

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const pause = (millis: number) => scheduler.wait(millis);

const send = (telegramUserId: number, text: string, messageId: number) =>
  telegramWebhook(textUpdate({ fromUserId: telegramUserId, text, messageId }));

const fireAlarm = async (ownerId: string) =>
  runDurableObjectAlarm(await agentOf(ownerId));

const noteTexts = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<{ text: string }>("SELECT text FROM notes")
      .toArray()
      .map((row) => row.text)
  );

const eventStates = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM inbox_events ORDER BY sequence"
      )
      .toArray()
      .map((row) => row.state)
  );

const waitBurst = (quietMillis: number, maxWaitMillis = 60_000) => {
  fakeBurstWait.quietMillis = quietMillis;
  fakeBurstWait.maxWaitMillis = maxWaitMillis;
};

beforeEach(() => {
  resetFakes();
});

describe(
  "A burst of Owner messages waits for a quiet gap",
  { timeout: 20_000 },
  () => {
    it("gives three messages within the gap one model call and one outcome on the newest, and a later message a second Turn", async () => {
      const ownerId = await addOwner(13_101);
      waitBurst(1500);

      await send(13_101, "first", 61);
      await send(13_101, "second", 62);
      await send(13_101, "third", 63);
      await fireAlarm(ownerId);

      expect(fakeModel.doGenerateCalls).toEqual([]);
      expect(fakeTelegram.sent).toEqual([]);

      await pause(1600);
      await fireAlarm(ownerId);
      await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
        timeout: 5000,
      });
      expect(fakeModel.doGenerateCalls).toHaveLength(1);
      expect(ownerTextsOf(fakeModel.doGenerateCalls[0]?.prompt ?? [])).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(fakeTelegram.sent[0]?.body).toMatchObject({
        text: `${fakeReplyPrefix}third`,
        reply_parameters: { message_id: 63 },
      });
      expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);

      await send(13_101, "fourth", 64);
      await pause(1600);
      await fireAlarm(ownerId);
      await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
        timeout: 5000,
      });
      expect(fakeModel.doGenerateCalls).toHaveLength(2);
      expect(ownerTextsOf(fakeModel.doGenerateCalls[1]?.prompt ?? [])).toEqual([
        "first",
        "second",
        "third",
        "fourth",
      ]);
      expect(fakeTelegram.sent[1]?.body.reply_parameters).toMatchObject({
        message_id: 64,
      });
    });

    it("starts the Turn no later than the maximum wait under a steady stream of messages", async () => {
      const ownerId = await addOwner(13_102);
      waitBurst(1000, 2000);
      const startedAt = Date.now();
      const streamMillis = 5000;
      const stream = async (
        messageId: number,
        firstCallAt: number | undefined
      ): Promise<{ lastId: number; firstCallAt: number | undefined }> => {
        if (Date.now() - startedAt >= streamMillis) {
          return { lastId: messageId - 1, firstCallAt };
        }
        await send(13_102, `part ${messageId}`, messageId);
        const calledAt =
          firstCallAt === undefined && fakeModel.doGenerateCalls.length > 0
            ? Date.now()
            : firstCallAt;
        await pause(250);
        return stream(messageId + 1, calledAt);
      };
      const { lastId, firstCallAt } = await stream(101, undefined);
      const sentDuringStream = lastId - 100;

      expect(firstCallAt).toBeDefined();
      expect(
        (firstCallAt ?? Number.POSITIVE_INFINITY) - startedAt
      ).toBeLessThan(2000 + 1000 + 500);
      const firstInputs = ownerTextsOf(
        fakeModel.doGenerateCalls[0]?.prompt ?? []
      );
      expect(firstInputs.length).toBeGreaterThan(1);
      expect(firstInputs.length).toBeLessThan(sentDuringStream);
      await fireAlarm(ownerId);
      await vi.waitFor(
        async () => {
          const states = await eventStates(ownerId);
          expect(states.every((state) => state === "done")).toBe(true);
        },
        { timeout: 10_000 }
      );
    });

    it("keeps typing on while the burst waits, from each message until the Turn starts", async () => {
      const ownerId = await addOwner(13_103);
      waitBurst(1500);

      const sentAt = Date.now();
      await send(13_103, "one", 71);
      await vi.waitFor(() => expect(fakeTelegram.chatActions).toHaveLength(1));
      const [first] = fakeTelegram.chatActions;
      expect(first).toMatchObject({ chatId: 13_103, action: "typing" });
      expect((first?.at ?? Number.POSITIVE_INFINITY) - sentAt).toBeLessThan(
        1000
      );
      await send(13_103, "two", 72);
      await vi.waitFor(() => expect(fakeTelegram.chatActions).toHaveLength(2));
      expect(fakeModel.doGenerateCalls).toEqual([]);

      await pause(1600);
      await fireAlarm(ownerId);
      await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
        timeout: 5000,
      });
      expect(fakeTelegram.chatActionsAtModelCalls[0]).toBeGreaterThanOrEqual(3);
    });

    it("answers a message that arrived during a Turn once its quiet gap has passed, not a minute later", async () => {
      const ownerId = await addOwner(13_107);
      waitBurst(300);
      const releaseModel = holdModel();

      await send(13_107, "first", 97);
      await vi.waitFor(
        () => expect(fakeModel.doGenerateCalls).toHaveLength(1),
        { timeout: 5000 }
      );
      await send(13_107, "second", 98);
      await pause(1000);
      const releasedAt = Date.now();
      releaseModel();

      await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
        timeout: 10_000,
      });
      expect(Date.now() - releasedAt).toBeLessThan(5000);
      expect(
        fakeTelegram.sent.map(
          (message) => message.body.reply_parameters?.message_id
        )
      ).toEqual([97, 98]);
      expect(await eventStates(ownerId)).toEqual(["done", "done"]);
    });

    it("saves the later value when a later message of the burst corrects an earlier one", async () => {
      const ownerId = await addOwner(13_104);
      waitBurst(1000);
      scriptModel([
        {
          callTool: captureNoteToolName,
          input: { text: "dentist on Thursday" },
        },
        { say: "Kept: dentist on Thursday" },
      ]);

      await send(13_104, "keep: dentist on Friday", 81);
      await send(13_104, "actually Thursday, not Friday", 82);
      await pause(1100);
      await fireAlarm(ownerId);
      await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
        timeout: 5000,
      });

      const [call] = fakeModel.doGenerateCalls;
      expect(ownerTextsOf(call?.prompt ?? [])).toEqual([
        "keep: dentist on Friday",
        "actually Thursday, not Friday",
      ]);
      expect(systemTextOf(call?.prompt ?? [])).toContain(
        "the later value replaces the earlier one"
      );
      expect(await noteTexts(ownerId)).toEqual(["dentist on Thursday"]);
    });

    it("gives one outcome for the burst after a Durable Object reset during the quiet gap", async () => {
      const ownerId = await addOwner(13_105);
      waitBurst(1500);

      await send(13_105, "first", 91);
      await send(13_105, "second", 92);
      await abortAllDurableObjects();
      await pause(1600);
      await fireAlarm(ownerId);

      await vi.waitFor(
        async () =>
          expect(await eventStates(ownerId)).toEqual(["done", "done"]),
        { timeout: 5000 }
      );
      await pause(1500);
      await fireAlarm(ownerId);
      expect(fakeModel.doGenerateCalls).toHaveLength(1);
      expect(fakeTelegram.sent).toHaveLength(1);
      expect(fakeTelegram.sent[0]?.body.reply_parameters).toMatchObject({
        message_id: 92,
      });
    });

    it("still fires a Schedule that is due during the quiet gap on time", async () => {
      const ownerId = await addOwner(13_106);
      waitBurst(4000);

      await send(13_106, "hello", 95);
      const dueAt = await runInDurableObject(
        await agentOf(ownerId),
        (instance) =>
          instance.runtime.runPromise(
            Effect.gen(function* setReminder() {
              const schedules = yield* Schedules;
              const now = yield* DateTime.now;
              const due = DateTime.add(now, { milliseconds: 200 });
              yield* schedules.set({
                action: { _tag: "SendText", text: "Stretch" },
                setBy: "owner",
                dueAt: due,
                sourceEventId: "seed-burst-wait",
              });
              return DateTime.toEpochMillis(due);
            })
          )
      );

      await vi.waitFor(
        () =>
          expect(fakeTelegram.sent.map((message) => message.body.text)).toEqual(
            ["Stretch"]
          ),
        { timeout: 3000 }
      );
      expect(Date.now() - dueAt).toBeLessThan(2000);
      expect(fakeModel.doGenerateCalls).toEqual([]);

      await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
        timeout: 6000,
      });
      expect(fakeTelegram.sent[1]?.body).toMatchObject({
        text: `${fakeReplyPrefix}hello`,
        reply_parameters: { message_id: 95 },
      });
    });
  }
);
