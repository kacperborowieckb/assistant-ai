import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeModel, fakeTelegram, fakeTool, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const firstCall = () => fakeModel.doGenerateCalls[0];

const systemPromptOfFirstCall = () => {
  const system = firstCall()?.prompt.find(
    (message) => message.role === "system"
  );
  return system?.role === "system" ? system.content : "";
};

const toolNamesOfFirstCall = () =>
  (firstCall()?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => name !== fakeTool.name);

beforeEach(() => {
  resetFakes();
});

describe("Capabilities in the system prompt", () => {
  it("names every tool of an Owner message Turn and says what the agent cannot do", async () => {
    await addOwner(8301);
    await telegramWebhook(
      textUpdate({ fromUserId: 8301, text: "what can you do?" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });

    const prompt = systemPromptOfFirstCall();
    const toolNames = toolNamesOfFirstCall();
    expect(toolNames.length).toBeGreaterThan(0);
    for (const toolName of toolNames) {
      expect(prompt).toContain(toolName);
    }
    expect(prompt).toContain("never from your earlier replies");
    expect(prompt).toContain("You cannot open links");
  });
});
