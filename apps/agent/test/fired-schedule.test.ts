import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import type { ScheduleAction } from "../src/schedule/schedule-action.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { fakeModel, fakeTelegram, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Inbox | Schedules>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const ownerWithConversation = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text: "hi" }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  return ownerId;
};

const cancelledBeforeItFires = (ownerId: string, action: ScheduleAction) =>
  inAgent(
    ownerId,
    Effect.gen(function* cancelledBeforeItFiresEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      const { schedule } = yield* schedules.set({
        action,
        setBy: "owner",
        dueAt: DateTime.subtract(now, { seconds: 5 }),
        sourceEventId: "seed-fired-schedule",
      });
      yield* storeDueScheduleEvents;
      yield* schedules.cancel({
        scheduleId: schedule.scheduleId,
        eventId: "cancel",
      });
    })
  );

const runTheTurn = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) => instance.runTurn());

const pendingEvents = (ownerId: string) =>
  inAgent(ownerId, Inbox.pipe(Effect.flatMap((inbox) => inbox.pending)));

beforeEach(() => {
  resetFakes();
});

describe.each([
  {
    name: "Reminder",
    telegramUserId: 9601,
    action: { _tag: "SendText", text: "Buy the gift" },
  },
  {
    name: "Scheduled Task",
    telegramUserId: 9602,
    action: { _tag: "RunPrompt", prompt: "List my tasks" },
  },
] as const)(
  "a fired $name that is no longer due",
  ({ telegramUserId, action }) => {
    it("sends nothing, runs no model, and finishes the Event", async () => {
      const ownerId = await ownerWithConversation(telegramUserId);
      const modelCallsBefore = fakeModel.doGenerateCalls.length;
      await cancelledBeforeItFires(ownerId, action);

      await runTheTurn(ownerId);

      expect(fakeTelegram.sent).toHaveLength(1);
      expect(fakeModel.doGenerateCalls).toHaveLength(modelCallsBefore);
      expect(await pendingEvents(ownerId)).toEqual([]);
    });
  }
);
