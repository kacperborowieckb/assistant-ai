import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { closeOpenLoopToolName } from "../src/notes/close-open-loop-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { OwnerChannelConversation } from "../src/personal-agent/owner-channel-conversation.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { receiveEvent } from "../src/personal-agent/receive-event.ts";
import { staySilentToolName } from "../src/personal-agent/stay-silent-tool.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { ProactiveMessages } from "../src/proactive/proactive-messages.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import type { AlarmClock } from "../src/schedule/schedules.ts";
import {
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const { proactiveResponseWindowMillis } = defaultBehaviorConfig;

interface ProactiveMessageRow extends Record<string, SqlStorageValue> {
  event_id: string;
  outcome: string | null;
  connected_event_id: string | null;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    Journal | Notes | ProactiveMessages | Schedules | Inbox
  >
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const proactiveRowsOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ProactiveMessageRow>(
        "SELECT event_id, outcome, connected_event_id FROM proactive_messages ORDER BY sent_at"
      )
      .toArray()
  );

const outcomeOf = async (ownerId: string) => {
  const [row] = await proactiveRowsOf(ownerId);
  return row?.outcome;
};

const outcomeEntriesOf = async (ownerId: string) => {
  const entries = await inAgent(
    ownerId,
    Journal.pipe(Effect.flatMap((journal) => journal.read))
  );
  return entries.flatMap(({ record }) =>
    record._tag === "ProactiveMessageOutcome" ? [record] : []
  );
};

const outcomesRecordedFor = async (ownerId: string) => {
  const entries = await outcomeEntriesOf(ownerId);
  return entries.map((entry) => entry.outcome);
};

const outcomeMetrics = () =>
  fakeMetrics.dataPoints.filter((point) => point.blobs?.[0] === "outcome");

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

const keepOpenLoop = async (ownerId: string, text: string) => {
  const kept = await inAgent(
    ownerId,
    Notes.pipe(
      Effect.flatMap((notes) =>
        notes.capture({
          text,
          source: {
            eventId: `source-${text}`,
            channel: "telegram",
            conversationId: "1",
            channelMessageId: "1",
            trustLevel: "owner",
          },
          openLoop: { kind: "task" },
        })
      )
    )
  );
  return kept.note;
};

const sendBrief = async (ownerId: string, sentSoFar: number) => {
  scriptModel([{ say: "Good morning. Buy a gift for Ana today." }]);
  await runInDurableObject(await agentOf(ownerId), (instance, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE set_by = 'agent'",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      )
    );
    return instance.fireDueSchedules();
  });
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sentSoFar + 1));
  await vi.waitFor(async () =>
    expect(await proactiveRowsOf(ownerId)).toHaveLength(sentSoFar)
  );
};

const ownerWrites = async (telegramUserId: number, text: string) => {
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));
};

const systemPromptOfLastModelCall = () => {
  const call = fakeModel.doGenerateCalls.at(-1);
  const system = call?.prompt.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
};

beforeEach(() => {
  resetFakes();
});

describe("the Outcome of a Proactive Message in a connected Turn", () => {
  it("records acted when the connected Turn closes an Open Loop of the message, and shows the message to the Turn", async () => {
    const ownerId = await ownerWithBrief(9801);
    const note = await keepOpenLoop(ownerId, "Buy a gift for Ana");
    await sendBrief(ownerId, 1);
    scriptModel([
      {
        callTool: closeOpenLoopToolName,
        input: { noteId: note.noteId, reason: "done" },
      },
      { say: "Closed" },
    ]);

    await ownerWrites(9801, "I bought the gift");

    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("acted")
    );
    const system = fakeModel.doGenerateCalls
      .map((call) => call.prompt.find((message) => message.role === "system"))
      .find(
        (message) =>
          typeof message?.content === "string" &&
          message.content.includes("follows a Proactive Message")
      );
    expect(system?.content).toContain(
      "The Proactive Message said: Good morning. Buy a gift for Ana today."
    );
    expect(system?.content).toContain(`- ${note.noteId} (task, open`);
    const [row] = await proactiveRowsOf(ownerId);
    expect(await outcomeEntriesOf(ownerId)).toEqual([
      {
        _tag: "ProactiveMessageOutcome",
        eventId: row?.event_id,
        outcome: "acted",
        connectedEventId: row?.connected_event_id,
      },
    ]);
    expect(outcomeMetrics().map((point) => point.blobs)).toEqual([
      ["outcome", "acted", "", "", row?.event_id],
    ]);
  });

  it("records replied when the connected Turn changes no Open Loop", async () => {
    const ownerId = await ownerWithBrief(9802);
    await keepOpenLoop(ownerId, "Call the bank");
    await sendBrief(ownerId, 1);
    scriptModel([{ say: "Sure" }]);

    await ownerWrites(9802, "Thanks, I will look at it later");

    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("replied")
    );
    expect(await outcomesRecordedFor(ownerId)).toEqual(["replied"]);
  });

  it("records replied when the connected Turn stays silent", async () => {
    const ownerId = await ownerWithBrief(9809);
    await keepOpenLoop(ownerId, "Call the bank");
    await sendBrief(ownerId, 1);
    scriptModel([{ callTool: staySilentToolName, input: {} }]);

    await ownerWrites(9809, "ok");

    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("replied")
    );
    expect(await outcomesRecordedFor(ownerId)).toEqual(["replied"]);
    expect(fakeTelegram.sent).toHaveLength(2);
  });

  it("connects only the next Owner message, so the first Outcome stays", async () => {
    const ownerId = await ownerWithBrief(9803);
    await keepOpenLoop(ownerId, "Pay the rent");
    await sendBrief(ownerId, 1);
    scriptModel([{ say: "Sure" }]);
    await ownerWrites(9803, "ok");
    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("replied")
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3));

    scriptModel([{ say: "Fine" }]);
    await ownerWrites(9803, "and another thing");
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(4));

    expect(systemPromptOfLastModelCall()).not.toContain(
      "follows a Proactive Message"
    );
    expect(await outcomeEntriesOf(ownerId)).toHaveLength(1);
  });

  it("records the Outcome once when the recording runs again", async () => {
    const ownerId = await ownerWithBrief(9804);
    await sendBrief(ownerId, 1);
    scriptModel([{ say: "Sure" }]);
    await ownerWrites(9804, "ok");
    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("replied")
    );
    const [row] = await proactiveRowsOf(ownerId);

    const again = await inAgent(
      ownerId,
      ProactiveMessages.pipe(
        Effect.flatMap((messages) =>
          messages.recordOutcomeOfConnectedTurn(row?.connected_event_id ?? "")
        )
      )
    );

    expect(Option.isNone(again)).toBe(true);
    expect(await outcomeEntriesOf(ownerId)).toHaveLength(1);
    expect(outcomeMetrics()).toHaveLength(1);
  });
});

describe("a reset after the reply to a connected message", () => {
  it("records the Outcome when the Turn recovers, with no second reply", async () => {
    const ownerId = await ownerWithBrief(9805);
    await sendBrief(ownerId, 1);
    const modelCallsBefore = fakeModel.doGenerateCalls.length;

    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* answeredBeforeReset() {
          const journal = yield* Journal;
          yield* receiveEvent({
            _tag: "OwnerMessage",
            channel: "telegram",
            channelUpdateId: "reset-1",
            conversationId: "1",
            channelMessageId: "reset-1",
            text: "ok",
            sentAt: new Date().toISOString(),
          });
          const inbox = yield* Inbox;
          const [event] = yield* inbox.pending;
          const eventId = event?.eventId ?? "";
          yield* journal.append({
            _tag: "ReplyPlanned",
            eventId,
            text: "Sure",
          });
          yield* journal.append({ _tag: "SendStarted", eventId });
          yield* journal.append({
            _tag: "ReplySent",
            eventId,
            channelMessageId: "9999",
          });
        })
      )
    );
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.runTurn()
    );

    expect(await outcomeOf(ownerId)).toBe("replied");
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCallsBefore);
    expect(await outcomeEntriesOf(ownerId)).toHaveLength(1);
  });
});

describe("a reset after the connected Turn left the Inbox", () => {
  it("records the Outcome at the next alarm, once", async () => {
    const ownerId = await ownerWithBrief(9806);
    await sendBrief(ownerId, 1);
    await runInDurableObject(await agentOf(ownerId), (instance) =>
      instance.runtime.runPromise(
        receiveEvent({
          _tag: "OwnerMessage",
          channel: "telegram",
          channelUpdateId: "reset-2",
          conversationId: "1",
          channelMessageId: "reset-2",
          text: "ok",
          sentAt: new Date().toISOString(),
        })
      )
    );
    await runInDurableObject(await agentOf(ownerId), (_, state) => {
      state.storage.sql.exec(
        "UPDATE inbox_events SET state = 'done' WHERE kind = 'OwnerMessage'"
      );
    });
    expect(await outcomeOf(ownerId)).toBeNull();

    await runInDurableObject(await agentOf(ownerId), async (instance) => {
      await instance.fireDueSchedules();
      await instance.fireDueSchedules();
    });

    expect(await outcomeOf(ownerId)).toBe("replied");
    expect(await outcomesRecordedFor(ownerId)).toEqual(["replied"]);
    expect(outcomeMetrics()).toHaveLength(1);
  });
});

describe("the ignored Outcome", () => {
  it("records ignored at the end of the window with no model call, once, even when the alarm runs twice", async () => {
    const ownerId = await ownerWithBrief(9810);
    await sendBrief(ownerId, 1);
    const modelCallsBefore = fakeModel.doGenerateCalls.length;
    await runInDurableObject(await agentOf(ownerId), (_, state) => {
      state.storage.sql.exec(
        "UPDATE proactive_messages SET window_ends_at = ?",
        DateTime.formatIso(
          DateTime.subtract(DateTime.nowUnsafe(), { milliseconds: 1 })
        )
      );
    });

    await runInDurableObject(await agentOf(ownerId), async (instance) => {
      await instance.fireDueSchedules();
      await instance.fireDueSchedules();
    });

    expect(await outcomeOf(ownerId)).toBe("ignored");
    const entries = await outcomeEntriesOf(ownerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: "ignored",
      connectedEventId: null,
    });
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCallsBefore);
    expect(outcomeMetrics()).toHaveLength(1);
  });

  it("does not record ignored for a message that was connected", async () => {
    const ownerId = await ownerWithBrief(9811);
    await sendBrief(ownerId, 1);
    scriptModel([{ say: "Sure" }]);
    await ownerWrites(9811, "ok");
    await vi.waitFor(async () =>
      expect(await outcomeOf(ownerId)).toBe("replied")
    );

    await runInDurableObject(
      await agentOf(ownerId),
      async (instance, state) => {
        state.storage.sql.exec(
          "UPDATE proactive_messages SET window_ends_at = '2000-01-01T00:00:00.000Z'"
        );
        await instance.fireDueSchedules();
      }
    );

    expect(await outcomesRecordedFor(ownerId)).toEqual(["replied"]);
  });

  it("shows the recent Outcomes of an Open Loop to the next proactive Turn", async () => {
    const ownerId = await ownerWithBrief(9812);
    await keepOpenLoop(ownerId, "Renew the passport");
    await sendBrief(ownerId, 1);
    await runInDurableObject(
      await agentOf(ownerId),
      async (instance, state) => {
        state.storage.sql.exec(
          "UPDATE proactive_messages SET window_ends_at = '2000-01-01T00:00:00.000Z'"
        );
        await instance.fireDueSchedules();
      }
    );
    expect(await outcomeOf(ownerId)).toBe("ignored");

    await sendBrief(ownerId, 2);

    const system = systemPromptOfLastModelCall();
    expect(system).toContain("Renew the passport");
    expect(system).toContain(
      "recent Outcomes of earlier Proactive Messages about it, newest first: ignored"
    );
    expect(system).toContain("change your approach");
  });
});

interface SentProactiveMessage {
  readonly eventId: string;
  readonly sentAt: number;
}

const withStore = async <A, E>(
  agentName: string,
  alarmClock: AlarmClock,
  effect: Effect.Effect<
    A,
    E,
    | AgentStorage
    | Journal
    | ProactiveMessages
    | Schedules
    | Inbox
    | OwnerChannelConversation
  >
) => {
  const agent = await agentOf(agentName);
  return runInDurableObject(agent, (_, state) => {
    const ownerId = OwnerIdSchema.make(agentName);
    const journal = Journal.layer(ownerId);
    const services = Layer.mergeAll(
      ProactiveMessages.layer.pipe(Layer.provide(journal)),
      Schedules.layer(ownerId, alarmClock).pipe(Layer.provide(journal)),
      Inbox.layer.pipe(Layer.provide(journal)),
      OwnerChannelConversation.layer,
      journal
    ).pipe(
      Layer.provideMerge(AgentStorage.layer(state.storage)),
      Layer.provideMerge(TestClock.layer())
    );
    return Effect.runPromise(effect.pipe(Effect.provide(services)));
  });
};

const noAlarm: AlarmClock = { setAt: () => Promise.resolve() };

const startOfTime = Date.parse("2027-01-14T10:00:00.000Z");

const sendProactiveMessage = Effect.fnUntraced(function* sendProactiveMessage(
  { eventId, sentAt }: SentProactiveMessage,
  openLoopIds: readonly string[] = []
) {
  const messages = yield* ProactiveMessages;
  yield* TestClock.setTime(sentAt);
  yield* messages.plan(eventId, openLoopIds);
  yield* messages.recordSent(
    eventId,
    `message-${eventId}`,
    proactiveResponseWindowMillis
  );
});

const ownerMessageArrives = Effect.fnUntraced(function* ownerMessageArrives(
  at: number,
  channelUpdateId: string
) {
  yield* TestClock.setTime(at);
  const inbox = yield* Inbox;
  const messages = yield* ProactiveMessages;
  const eventId = yield* inbox.storeEvent({
    _tag: "OwnerMessage",
    channel: "telegram",
    channelUpdateId,
    conversationId: "1",
    channelMessageId: channelUpdateId,
    text: "hello",
    sentAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
  });
  yield* messages.connect(Option.getOrThrow(eventId));
  return Option.getOrThrow(eventId);
});

describe("the response window", () => {
  it("connects a message at exactly the window end", async () => {
    const connected = await withStore(
      "outcome-boundary-exact",
      noAlarm,
      Effect.gen(function* boundary() {
        yield* sendProactiveMessage({ eventId: "pm-1", sentAt: startOfTime });
        const eventId = yield* ownerMessageArrives(
          startOfTime + proactiveResponseWindowMillis,
          "u-1"
        );
        const messages = yield* ProactiveMessages;
        return yield* messages.connectedTo(eventId);
      })
    );

    expect(connected?.eventId).toBe("pm-1");
  });

  it("does not connect a message one millisecond after the window end", async () => {
    const connected = await withStore(
      "outcome-boundary-late",
      noAlarm,
      Effect.gen(function* boundary() {
        yield* sendProactiveMessage({ eventId: "pm-1", sentAt: startOfTime });
        const eventId = yield* ownerMessageArrives(
          startOfTime + proactiveResponseWindowMillis + 1,
          "u-1"
        );
        const messages = yield* ProactiveMessages;
        return yield* messages.connectedTo(eventId);
      })
    );

    expect(connected).toBeUndefined();
  });

  it("ends the connection to the first message when a second one is sent", async () => {
    const result = await withStore(
      "outcome-second-message",
      noAlarm,
      Effect.gen(function* second() {
        const messages = yield* ProactiveMessages;
        yield* sendProactiveMessage({ eventId: "pm-1", sentAt: startOfTime });
        yield* sendProactiveMessage({
          eventId: "pm-2",
          sentAt: startOfTime + 60_000,
        });
        const eventId = yield* ownerMessageArrives(
          startOfTime + 120_000,
          "u-1"
        );
        yield* TestClock.setTime(
          startOfTime + proactiveResponseWindowMillis + 1
        );
        const ignored = yield* messages.ignoreExpired();
        return {
          connectedTo: (yield* messages.connectedTo(eventId))?.eventId,
          ignored: ignored.map((recorded) => recorded.eventId),
        };
      })
    );

    expect(result).toEqual({ connectedTo: "pm-2", ignored: ["pm-1"] });
  });

  it("keeps the original send instant when the send is recorded after a reset", async () => {
    const connected = await withStore(
      "outcome-recovered-send",
      noAlarm,
      Effect.gen(function* recoveredSend() {
        const journal = yield* Journal;
        const messages = yield* ProactiveMessages;
        const sentAt = Date.now();
        yield* TestClock.setTime(sentAt);
        yield* messages.plan("pm-1", []);
        yield* journal.append({
          _tag: "ReplySent",
          eventId: "pm-1",
          channelMessageId: "m-1",
        });
        yield* TestClock.setTime(
          sentAt + proactiveResponseWindowMillis + 2 * 60 * 60 * 1000
        );
        yield* messages.recordSent(
          "pm-1",
          "m-1",
          proactiveResponseWindowMillis
        );
        const eventId = yield* ownerMessageArrives(
          sentAt + proactiveResponseWindowMillis + 2 * 60 * 60 * 1000,
          "u-1"
        );
        return yield* messages.connectedTo(eventId);
      })
    );

    expect(connected).toBeUndefined();
  });

  it("ignores a message only after its window end", async () => {
    const result = await withStore(
      "outcome-ignored-boundary",
      noAlarm,
      Effect.gen(function* ignoredBoundary() {
        const messages = yield* ProactiveMessages;
        yield* sendProactiveMessage({ eventId: "pm-1", sentAt: startOfTime });
        yield* TestClock.setTime(startOfTime + proactiveResponseWindowMillis);
        const atEnd = yield* messages.ignoreExpired();
        yield* TestClock.setTime(
          startOfTime + proactiveResponseWindowMillis + 1
        );
        const afterEnd = yield* messages.ignoreExpired();
        return { atEnd: atEnd.length, afterEnd: afterEnd.length };
      })
    );

    expect(result).toEqual({ atEnd: 0, afterEnd: 1 });
  });
});

describe("the recent Outcomes of an Open Loop", () => {
  it("keeps the last three for the Open Loop, however many other messages followed", async () => {
    const recent = await withStore(
      "outcome-recent",
      noAlarm,
      Effect.gen(function* recent() {
        const messages = yield* ProactiveMessages;
        yield* sendProactiveMessage({ eventId: "old", sentAt: startOfTime }, [
          "loop-a",
        ]);
        for (let index = 0; index < 60; index += 1) {
          yield* sendProactiveMessage(
            {
              eventId: `other-${index}`,
              sentAt: startOfTime + (index + 1) * 1000,
            },
            ["loop-b"]
          );
        }
        yield* TestClock.setTime(
          startOfTime + 2 * proactiveResponseWindowMillis
        );
        yield* messages.ignoreExpired();
        return yield* messages.recentOutcomesOf(["loop-a", "loop-b", "loop-c"]);
      })
    );

    expect(recent.get("loop-a")).toEqual(["ignored"]);
    expect(recent.get("loop-b")).toEqual(["ignored", "ignored", "ignored"]);
    expect(recent.get("loop-c")).toEqual([]);
  });
});

describe("the alarm of the Schedules store", () => {
  it("is armed one millisecond after the window end of a sent message that nobody answered", async () => {
    const armed: Option.Option<DateTime.Utc>[] = [];
    const alarmClock: AlarmClock = {
      setAt: (dueAt) => {
        armed.push(dueAt);
        return Promise.resolve();
      },
    };

    await withStore(
      "outcome-alarm",
      alarmClock,
      Effect.gen(function* alarm() {
        const schedules = yield* Schedules;
        yield* sendProactiveMessage({ eventId: "pm-1", sentAt: startOfTime });
        yield* schedules.complete("none", "none", "pm-1");
      })
    );

    expect(armed.at(-1)).toEqual(
      Option.some(
        DateTime.makeUnsafe(startOfTime + proactiveResponseWindowMillis + 1)
      )
    );
  });

  it("is armed a minute ahead while a Turn is answering a connected message", async () => {
    const armed: Option.Option<DateTime.Utc>[] = [];
    const alarmClock: AlarmClock = {
      setAt: (dueAt) => {
        armed.push(dueAt);
        return Promise.resolve();
      },
    };

    await withStore(
      "outcome-alarm-connected",
      alarmClock,
      Effect.gen(function* alarm() {
        const schedules = yield* Schedules;
        yield* sendProactiveMessage({ eventId: "pm-1", sentAt: startOfTime });
        yield* ownerMessageArrives(startOfTime + 60_000, "u-1");
        yield* schedules.complete("none", "none", "pm-1");
      })
    );

    expect(armed.at(-1)).toEqual(
      Option.some(DateTime.makeUnsafe(startOfTime + 120_000))
    );
  });
});

describe("the alarm after a connected Turn left the Inbox", () => {
  it("stays armed until the Outcome is recorded", async () => {
    const armed: Option.Option<DateTime.Utc>[] = [];
    const alarmClock: AlarmClock = {
      setAt: (dueAt) => {
        armed.push(dueAt);
        return Promise.resolve();
      },
    };

    await withStore(
      "outcome-alarm-finished",
      alarmClock,
      Effect.gen(function* alarm() {
        const schedules = yield* Schedules;
        const inbox = yield* Inbox;
        const messages = yield* ProactiveMessages;
        yield* sendProactiveMessage({ eventId: "pm-1", sentAt: startOfTime });
        yield* ownerMessageArrives(startOfTime + 60_000, "u-1");
        yield* schedules.complete("none", "none", "pm-1");
        const armedWhilePending = armed.at(-1);
        yield* inbox.markDone(yield* inbox.pending);
        yield* schedules.complete("none", "none", "pm-1");
        const armedWhileOpen = armed.at(-1);
        yield* messages.settleFinishedTurns();
        yield* schedules.complete("none", "none", "pm-1");
        expect(armedWhilePending).toEqual(
          Option.some(DateTime.makeUnsafe(startOfTime + 120_000))
        );
        expect(armedWhileOpen).toEqual(
          Option.some(DateTime.makeUnsafe(startOfTime + 60_000))
        );
        expect(armed.at(-1)).toEqual(Option.none());
      })
    );
  });
});

describe("receiving an Owner message", () => {
  it("stores the message and connects it in one step", async () => {
    const connected = await withStore(
      "outcome-receive",
      noAlarm,
      Effect.gen(function* receive() {
        yield* sendProactiveMessage({
          eventId: "pm-1",
          sentAt: Date.now() - 1000,
        });
        yield* receiveEvent({
          _tag: "OwnerMessage",
          channel: "telegram",
          channelUpdateId: "u-9",
          conversationId: "1",
          channelMessageId: "9",
          text: "hello",
          sentAt: new Date().toISOString(),
        });
        const messages = yield* ProactiveMessages;
        const inbox = yield* Inbox;
        const [event] = yield* inbox.pending;
        return yield* messages.connectedTo(event?.eventId ?? "");
      })
    );

    expect(connected?.eventId).toBe("pm-1");
  });
});
