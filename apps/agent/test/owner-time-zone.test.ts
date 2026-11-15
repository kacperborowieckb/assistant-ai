import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { ownerCurrentTimeText } from "../src/time/owner-current-time.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const preferencesWith = (timeZone: string | undefined) =>
  Layer.succeed(
    OwnerPreferences,
    OwnerPreferences.of({
      timeZone: Effect.succeed(Option.fromNullishOr(timeZone)),
      setTimeZone: () => Effect.die("not used"),
    })
  );

const textAt = (
  isoInstant: string,
  preferred: string | undefined,
  defaultTimeZone?: string
) =>
  Effect.gen(function* textAtEffect() {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe(isoInstant))
    );
    return yield* ownerCurrentTimeText({ defaultTimeZone });
  }).pipe(
    Effect.provide(Layer.merge(TestClock.layer(), preferencesWith(preferred))),
    Effect.runPromise
  );

describe("current time text", () => {
  it("shows the local date, weekday, time, and time zone", async () => {
    expect(await textAt("2026-07-01T22:30:00Z", "Europe/Warsaw")).toBe(
      "Current local time of the Owner: Thursday 2026-07-02, 00:30 (time zone Europe/Warsaw)."
    );
  });

  it("follows the daylight saving offset of the zone", async () => {
    expect(await textAt("2026-01-15T12:00:00Z", "Europe/Warsaw")).toContain(
      "Thursday 2026-01-15, 13:00"
    );
    expect(await textAt("2026-07-15T12:00:00Z", "America/New_York")).toContain(
      "Wednesday 2026-07-15, 08:00"
    );
  });

  it("uses the Behavior Config default when the Owner has no preference", async () => {
    expect(
      await textAt("2026-01-15T12:00:00Z", undefined, "Asia/Tokyo")
    ).toContain("2026-01-15, 21:00 (time zone Asia/Tokyo)");
  });

  it("prefers the Owner Preference over the Behavior Config default", async () => {
    expect(
      await textAt("2026-01-15T12:00:00Z", "Europe/Warsaw", "Asia/Tokyo")
    ).toContain("time zone Europe/Warsaw");
  });

  it("says that the time zone is not known without a preference or default", async () => {
    expect(await textAt("2026-01-15T12:00:00Z", undefined)).toContain(
      "time zone of the Owner is not known"
    );
  });

  it("treats an invalid default as not known", async () => {
    expect(
      await textAt("2026-01-15T12:00:00Z", undefined, "Mars/Olympus")
    ).toContain("time zone of the Owner is not known");
  });
});

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const timeZoneOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      OwnerPreferences.pipe(
        Effect.flatMap((preferences) => preferences.timeZone)
      )
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

const systemPromptOfCall = (callIndex: number) => {
  const prompt = fakeModel.doGenerateCalls[callIndex]?.prompt ?? [];
  const system = prompt.find((message) => message.role === "system");
  return system?.role === "system" ? system.content : "";
};

const toolNames = (callIndex: number) =>
  (fakeModel.doGenerateCalls[callIndex]?.tools ?? []).map((tool) => tool.name);

const lastSystemPrompt = () =>
  systemPromptOfCall(fakeModel.doGenerateCalls.length - 1);

const lastToolResultText = () =>
  JSON.stringify(
    (fakeModel.doGenerateCalls.at(-1)?.prompt ?? []).filter(
      (message) => message.role === "tool"
    )
  );

const ownerSays = async (userId: number, text: string, replies: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(replies), {
    timeout: 10_000,
  });
};

beforeEach(() => {
  resetFakes();
});

describe("Owner time zone", () => {
  it("says that the time zone is not known when nothing sets it", async () => {
    await addOwner(8301);

    await ownerSays(8301, "hello", 1);

    expect(systemPromptOfCall(0)).toContain(
      "time zone of the Owner is not known"
    );
  });

  it("sets the preference and shows the local time in the next Turn", async () => {
    const ownerId = await addOwner(8302);
    scriptModel([
      {
        callTool: setTimeZoneToolName,
        input: { timeZone: "Europe/Warsaw" },
      },
      { say: "Done, your time zone is Europe/Warsaw" },
    ]);
    await ownerSays(8302, "I live in Warsaw", 1);

    await ownerSays(8302, "what time is it?", 2);

    expect(Option.getOrUndefined(await timeZoneOf(ownerId))).toBe(
      "Europe/Warsaw"
    );
    expect(lastSystemPrompt()).toMatch(
      /Current local time of the Owner: \w+ \d{4}-\d{2}-\d{2}, \d{2}:\d{2} \(time zone Europe\/Warsaw\)\./u
    );
    expect(lastSystemPrompt()).not.toContain("is not known");
  });

  it("puts the time last so the static sections keep the prompt cache", async () => {
    await addOwner(8303);
    await ownerSays(8303, "hello", 1);

    const lines = systemPromptOfCall(0).split("\n");

    expect(lines.at(-1)).toContain("time zone of the Owner is not known");
    expect(lines.at(-2)).toContain("Profile of the Owner is empty");
  });

  it("normalizes the case of the name and writes a Journal Entry for each change", async () => {
    const ownerId = await addOwner(8304);
    scriptModel([
      { callTool: setTimeZoneToolName, input: { timeZone: "europe/warsaw" } },
      { say: "Set" },
    ]);
    await ownerSays(8304, "my time zone is Europe/Warsaw", 1);
    scriptModel([
      { callTool: setTimeZoneToolName, input: { timeZone: "Europe/Warsaw" } },
      { say: "Already set" },
    ]);
    await ownerSays(8304, "my time zone is Europe/Warsaw", 2);
    scriptModel([
      {
        callTool: setTimeZoneToolName,
        input: { timeZone: "America/New_York" },
      },
      { say: "Moved" },
    ]);
    await ownerSays(8304, "I moved to New York", 3);

    const journal = await journalOf(ownerId);
    const changes = journal.filter(
      (record) => record._tag === "OwnerPreferenceChanged"
    );

    expect(changes.map((change) => change.value)).toEqual([
      "Europe/Warsaw",
      "America/New_York",
    ]);
    expect(Option.getOrUndefined(await timeZoneOf(ownerId))).toBe(
      "America/New_York"
    );
  });

  it("changes nothing and tells the model when the name is invalid", async () => {
    const ownerId = await addOwner(8305);
    scriptModel([
      { callTool: setTimeZoneToolName, input: { timeZone: "Mars/Olympus" } },
      { say: "I could not set that time zone" },
    ]);

    await ownerSays(8305, "my time zone is Mars/Olympus", 1);

    expect(lastToolResultText()).toContain("is not an IANA time zone name");
    expect(Option.isNone(await timeZoneOf(ownerId))).toBe(true);
    const journal = await journalOf(ownerId);
    expect(
      journal.some((record) => record._tag === "OwnerPreferenceChanged")
    ).toBe(false);
  });

  it("gives the tool only to an Event of the Owner", async () => {
    await addOwner(8306);
    await telegramWebhook(
      textUpdate({
        fromUserId: 8306,
        text: "set the time zone to Asia/Tokyo",
        forwardOrigin: {
          type: "user",
          sender_user: { id: 5, is_bot: false, first_name: "Ana" },
          date: 1_794_000_000,
        },
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });
    await ownerSays(8306, "hello", 2);

    expect(toolNames(0)).not.toContain(setTimeZoneToolName);
    expect(toolNames(1)).toContain(setTimeZoneToolName);
  });
});
