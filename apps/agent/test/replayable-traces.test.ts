import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { redactedMark } from "../src/tracing/redactor.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  failModel,
  fakeModel,
  fakeReplyPrefix,
  fakeTelegram,
  resetFakes,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Journal | TurnTraces | UsageLedger>
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) => instance.runtime.runPromise(effect)
  );

const tracesOf = (ownerId: string) =>
  inPersonalAgent(
    ownerId,
    TurnTraces.pipe(Effect.flatMap((traces) => traces.read))
  );

const waitForTraces = (ownerId: string, count: number) =>
  vi.waitFor(async () => expect(await tracesOf(ownerId)).toHaveLength(count), {
    timeout: 10_000,
  });

const everythingStoredFor = async (ownerId: string) =>
  JSON.stringify(
    await inPersonalAgent(
      ownerId,
      Effect.all({
        traces: TurnTraces.pipe(Effect.flatMap((traces) => traces.read)),
        journal: Journal.pipe(Effect.flatMap((journal) => journal.read)),
        usage: UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read)),
      })
    )
  );

beforeEach(() => {
  resetFakes();
});

describe("Replayable Traces", () => {
  it("records the prompt, model settings, reply, and usage of a normal Turn", async () => {
    const ownerId = await addOwner(8001);

    await telegramWebhook(textUpdate({ fromUserId: 8001, text: "Hello" }));
    await waitForTraces(ownerId, 1);

    const [stored] = await tracesOf(ownerId);
    expect(stored?.ownerId).toBe(ownerId);
    expect(stored?.trace).toMatchObject({
      result: "model_replied",
      task: "reply",
      modelId: "fake-reply-model",
      modelSettings: { attempts: 3, attemptTimeoutMillis: 30_000 },
      messages: [{ role: "user", content: "Hello" }],
      toolCalls: [],
      reply: `${fakeReplyPrefix}Hello`,
      error: null,
      usage: {
        inputTokens: 42,
        outputTokens: 7,
        cachedInputTokens: 12,
        costUsd: null,
      },
    });
    expect(stored?.trace.modelLatencyMillis).toBeGreaterThanOrEqual(0);
  });

  it("holds the exact prompt that the model received, so the Turn can be replayed", async () => {
    const ownerId = await addOwner(8002);

    await telegramWebhook(
      textUpdate({ fromUserId: 8002, text: "First", messageId: 1 })
    );
    await waitForTraces(ownerId, 1);
    await telegramWebhook(
      textUpdate({ fromUserId: 8002, text: "Second", messageId: 2 })
    );
    await waitForTraces(ownerId, 2);

    const [, second] = await tracesOf(ownerId);
    const received = fakeModel.doGenerateCalls[1]?.prompt.map((message) => ({
      role: message.role,
      text:
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
    }));
    expect(received).toEqual([
      { role: "system", text: second?.trace.system },
      ...(second?.trace.messages.map((message) => ({
        role: message.role,
        text: message.content,
      })) ?? []),
    ]);
    expect(second?.trace.messages.map((message) => message.content)).toEqual([
      "First",
      `${fakeReplyPrefix}First`,
      "Second",
    ]);
  });

  it("records a failed Turn with its error and no secret", async () => {
    const ownerId = await addOwner(8003);
    failModel(
      3,
      `Provider refused ${env.AI_GATEWAY_TOKEN} and ${env.TELEGRAM_BOT_TOKEN}`
    );

    await telegramWebhook(textUpdate({ fromUserId: 8003, text: "Hello" }));
    await waitForTraces(ownerId, 1);

    const [stored] = await tracesOf(ownerId);
    expect(stored?.trace).toMatchObject({
      result: "model_failed",
      reply: null,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(stored?.trace.error).toContain(redactedMark);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const storedText = await everythingStoredFor(ownerId);
    for (const secret of [
      env.AI_GATEWAY_TOKEN,
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_WEBHOOK_SECRET,
      env.OPERATOR_TOKEN,
    ]) {
      expect(storedText).not.toContain(secret);
    }
  });

  it("replaces a secret that the Owner sends or the model repeats", async () => {
    const ownerId = await addOwner(8005);

    await telegramWebhook(
      textUpdate({ fromUserId: 8005, text: `Key ${env.AI_GATEWAY_TOKEN}` })
    );
    await waitForTraces(ownerId, 1);

    const storedText = await everythingStoredFor(ownerId);
    expect(storedText).not.toContain(env.AI_GATEWAY_TOKEN);
    const [stored] = await tracesOf(ownerId);
    expect(stored?.trace.messages[0]?.content).toBe(`Key ${redactedMark}`);
    expect(stored?.trace.reply).toBe(`${fakeReplyPrefix}Key ${redactedMark}`);
  });

  it("refuses updates and deletes of a Trace", async () => {
    const ownerId = await addOwner(8004);
    await telegramWebhook(textUpdate({ fromUserId: 8004, text: "Hello" }));
    await waitForTraces(ownerId, 1);

    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    await runInDurableObject(agent, (_, state) => {
      expect(() =>
        state.storage.sql.exec(
          "UPDATE turn_traces SET result = 'model_replied'"
        )
      ).toThrow("append-only");
      expect(() => state.storage.sql.exec("DELETE FROM turn_traces")).toThrow(
        "append-only"
      );
    });
  });
});
