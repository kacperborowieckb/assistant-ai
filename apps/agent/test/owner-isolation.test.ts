import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const readEverything = async (ownerId: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Effect.all({
          events: Inbox.pipe(Effect.flatMap((inbox) => inbox.pending)),
          journal: Journal.pipe(Effect.flatMap((journal) => journal.read)),
          traces: TurnTraces.pipe(Effect.flatMap((traces) => traces.read)),
          usage: UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read)),
        })
      )
  );

const searchNotesOf = async (ownerId: string, query: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Notes.pipe(Effect.flatMap((notes) => notes.search({ query, limit: 5 })))
      )
  );

beforeEach(() => {
  resetFakes();
});

describe("Owner isolation", () => {
  it("keeps the messages, Journal, Traces, and Usage of each Owner apart", async () => {
    const first = await addOwner(9101);
    const second = await addOwner(9102);

    await telegramWebhook(
      textUpdate({ fromUserId: 9101, text: "alpha-only-message" })
    );
    await telegramWebhook(
      textUpdate({ fromUserId: 9102, text: "bravo-only-message" })
    );
    await vi.waitFor(
      async () => {
        const firstNow = await readEverything(first);
        const secondNow = await readEverything(second);
        expect(firstNow.traces).toHaveLength(1);
        expect(secondNow.traces).toHaveLength(1);
      },
      { timeout: 10_000 }
    );

    const firstData = await readEverything(first);
    const secondData = await readEverything(second);

    expect(JSON.stringify(firstData)).not.toContain("bravo-only-message");
    expect(JSON.stringify(secondData)).not.toContain("alpha-only-message");
    for (const [ownerId, data] of [
      [first, firstData],
      [second, secondData],
    ] as const) {
      expect(data.journal.every((entry) => entry.ownerId === ownerId)).toBe(
        true
      );
      expect(data.traces.every((entry) => entry.ownerId === ownerId)).toBe(
        true
      );
      expect(data.usage.every((row) => row.ownerId === ownerId)).toBe(true);
      expect(data.usage).toHaveLength(1);
    }
  });

  it("never returns the Notes of one Owner in the search of another Owner", async () => {
    const first = await addOwner(9103);
    const second = await addOwner(9104);
    const source = {
      eventId: "isolation-event",
      channel: "telegram",
      conversationId: "9103",
      channelMessageId: "1",
      trustLevel: "owner",
    } as const;
    await runInDurableObject(
      await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(first)),
      (instance) =>
        instance.runtime.runPromise(
          Notes.pipe(
            Effect.flatMap((notes) =>
              notes.capture({ text: "alpha-secret-plan", source })
            )
          )
        )
    );

    const ofFirst = await searchNotesOf(first, "alpha-secret-plan");
    const ofSecond = await searchNotesOf(second, "alpha-secret-plan");

    expect(ofFirst.map((note) => note.text)).toEqual(["alpha-secret-plan"]);
    expect(ofSecond).toEqual([]);
  });
});
