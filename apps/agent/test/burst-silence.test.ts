import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import type { JournalRecord } from "../src/journal/journal.ts";
import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { staySilentToolName } from "../src/personal-agent/stay-silent-tool.ts";
import {
  fakeBursts,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner } from "./telegram-requests.ts";

const burstTexts = ["ok", "thanks", "👍"] as const;

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const storeBurst = async (
  ownerId: string,
  telegramUserId: number,
  records: (eventIds: readonly string[]) => readonly JournalRecord[] = () => []
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Effect.gen(function* storeBurstEffect() {
        const inbox = yield* Inbox;
        const journal = yield* Journal;
        for (const [index, text] of burstTexts.entries()) {
          yield* inbox.store({
            _tag: "OwnerMessage",
            channel: "telegram",
            channelUpdateId: `silent-burst-${index}`,
            conversationId: String(telegramUserId),
            channelMessageId: String(81 + index),
            text,
            sentAt: new Date().toISOString(),
          });
        }
        const eventIds = (yield* inbox.pending).map((event) => event.eventId);
        for (const record of records(eventIds)) {
          yield* journal.append(record);
        }
        return eventIds;
      })
    )
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

const journalTags = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Journal.pipe(
        Effect.flatMap((journal) => journal.read),
        Effect.map((entries) => entries.map((entry) => entry.record._tag))
      )
    )
  );

const runTurn = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) => instance.runTurn());

const silentBurst = (eventIds: readonly string[]): readonly JournalRecord[] => {
  const [turnEventId = "", ...others] = eventIds;
  return [
    ...others.map((eventId): JournalRecord => ({
      _tag: "AnsweredByTurn",
      eventId,
      turnEventId,
    })),
    { _tag: "StayedSilent", eventId: turnEventId },
  ];
};

beforeEach(() => {
  resetFakes();
});

describe("A burst of Owner messages that ends in silence", () => {
  it("sends nothing and marks every Event of the burst done", async () => {
    const ownerId = await addOwner(7201);
    await storeBurst(ownerId, 7201);
    fakeBursts.allPendingTogether = true;
    scriptModel([{ callTool: staySilentToolName, input: {} }]);

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(fakeTelegram.sent).toEqual([]);
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
    expect(await journalTags(ownerId)).toEqual([
      "EventReceived",
      "EventReceived",
      "EventReceived",
      "AnsweredByTurn",
      "AnsweredByTurn",
      "StayedSilent",
    ]);
  });

  it("settles the whole burst with no model call and no send after a reset that came after the silence", async () => {
    const ownerId = await addOwner(7202);
    await storeBurst(ownerId, 7202, silentBurst);

    await runTurn(ownerId);

    expect(fakeModel.doGenerateCalls).toEqual([]);
    expect(fakeTelegram.sent).toEqual([]);
    expect(await eventStates(ownerId)).toEqual(["done", "done", "done"]);
  });
});
