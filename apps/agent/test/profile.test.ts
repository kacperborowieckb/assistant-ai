import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { Profile } from "../src/profile/profile.ts";
import { updateProfileToolName } from "../src/profile/update-profile-tool.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const profileOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Profile.pipe(Effect.flatMap((profile) => profile.read))
    )
  );

const journalOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Journal.pipe(
        Effect.flatMap((journal) => journal.read),
        Effect.map((entries) => entries.map((entry) => entry.record))
      )
    )
  );

const toolCallsOfTraces = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      TurnTraces.pipe(
        Effect.flatMap((traces) => traces.read),
        Effect.map((stored) =>
          stored.flatMap(({ trace }) =>
            trace.steps.flatMap((step) => step.toolCalls)
          )
        )
      )
    )
  );

const systemPromptOfCall = (callIndex: number) => {
  const prompt = fakeModel.doGenerateCalls[callIndex]?.prompt ?? [];
  const system = prompt.find((message) => message.role === "system");
  return system?.role === "system" ? system.content : "";
};

const lastSystemPrompt = () =>
  systemPromptOfCall(fakeModel.doGenerateCalls.length - 1);

const lastToolResultText = () => {
  const prompt = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
  return JSON.stringify(prompt.filter((message) => message.role === "tool"));
};

const ownerSays = async (userId: number, text: string, replies: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(replies), {
    timeout: 10_000,
  });
};

beforeEach(() => {
  resetFakes();
});

describe("Profile in every Turn", () => {
  it("adds an entry and shows it in the prompt of the next Turn", async () => {
    const ownerId = await addOwner(8101);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "I am vegetarian" },
      },
      { say: "Noted" },
    ]);
    await ownerSays(8101, "I am vegetarian", 1);
    expect(await profileOf(ownerId)).toEqual([
      expect.objectContaining({ kind: "fact", text: "I am vegetarian" }),
    ]);

    await ownerSays(8101, "what should I cook?", 2);

    expect(lastSystemPrompt()).toContain("I am vegetarian");
  });

  it("puts the Profile in the prompt of the first model call of a Turn", async () => {
    await addOwner(8102);
    await ownerSays(8102, "hello", 1);

    expect(systemPromptOfCall(0)).toContain("Profile of the Owner is empty");
    expect(systemPromptOfCall(0)).toContain(
      "answer from the Profile when it holds the answer"
    );
  });

  it("takes a removed entry out of the next prompt", async () => {
    const ownerId = await addOwner(8103);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "style_rule", text: "Answer in French" },
      },
      { say: "Noted" },
    ]);
    await ownerSays(8103, "answer in French", 1);
    const [entry] = await profileOf(ownerId);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "remove", entryId: entry?.entryId },
      },
      { say: "Removed" },
    ]);
    await ownerSays(8103, "stop answering in French", 2);

    await ownerSays(8103, "hello again", 3);

    expect(await profileOf(ownerId)).toEqual([]);
    expect(lastSystemPrompt()).not.toContain("Answer in French");
  });

  it("writes nothing when an add passes the size limit and tells the model", async () => {
    const ownerId = await addOwner(8104);
    const limit = defaultBehaviorConfig.maxProfileCharacters;
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "a".repeat(limit - 10) },
      },
      { say: "Noted" },
    ]);
    await ownerSays(8104, "first long fact", 1);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "b".repeat(11) },
      },
      { say: "The Profile is full, so I added nothing." },
    ]);

    await ownerSays(8104, "one more fact", 2);

    expect(await profileOf(ownerId)).toHaveLength(1);
    expect(lastToolResultText()).toContain("The Profile is full");
    expect(fakeTelegram.sent.at(-1)?.body.text).toContain("full");
    const records = await journalOf(ownerId);
    expect(
      records.filter((record) => record._tag === "ProfileEntryAdded")
    ).toHaveLength(1);
  });

  it("appends a Journal Entry and a Trace tool call for each change", async () => {
    const ownerId = await addOwner(8105);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "I live in Gdansk" },
      },
      { say: "Noted" },
    ]);
    await ownerSays(8105, "I live in Gdansk", 1);
    const [entry] = await profileOf(ownerId);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "remove", entryId: entry?.entryId },
      },
      { say: "Removed" },
    ]);
    await ownerSays(8105, "I moved away", 2);

    const records = await journalOf(ownerId);
    expect(
      records.filter((record) => record._tag.startsWith("ProfileEntry"))
    ).toEqual([
      expect.objectContaining({
        _tag: "ProfileEntryAdded",
        entryId: entry?.entryId,
        kind: "fact",
      }),
      expect.objectContaining({
        _tag: "ProfileEntryRemoved",
        entryId: entry?.entryId,
      }),
    ]);
    const calls = await toolCallsOfTraces(ownerId);
    expect(
      calls.filter((call) => call.name === updateProfileToolName)
    ).toHaveLength(2);
  });

  it("refuses to remove an entry that the Owner does not have", async () => {
    const ownerId = await addOwner(8106);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "remove", entryId: "no-such-entry" },
      },
      { say: "I could not remove it" },
    ]);

    await ownerSays(8106, "forget my diet", 1);

    expect(lastToolResultText()).toContain("no entry with the id");
    const records = await journalOf(ownerId);
    expect(
      records.some((record) => record._tag.startsWith("ProfileEntry"))
    ).toBe(false);
  });
});
