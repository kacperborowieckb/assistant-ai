import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  JournalRecordSchema,
  answeringTurnEventIdOf,
} from "../src/journal/journal.ts";
import type { JournalEntry } from "../src/journal/journal.ts";
import { deliveryStateOfEntries } from "../src/personal-agent/delivery.ts";
import { ReplyTurnTraceSchema } from "../src/tracing/turn-trace.ts";

const eventId = "turn-event";

const earlierRecord = Schema.fromJsonString(
  Schema.TaggedUnion({
    EventReceived: { eventId: Schema.String },
    AnsweredByTurn: { eventId: Schema.String, turnEventId: Schema.String },
    TurnFailed: { eventId: Schema.String, reason: Schema.String },
    ReplyPlanned: { eventId: Schema.String, text: Schema.String },
    SendStarted: { eventId: Schema.String },
    ReplySent: { eventId: Schema.String, channelMessageId: Schema.String },
    ReplyFailed: { eventId: Schema.String, reason: Schema.String },
    StayedSilent: { eventId: Schema.String },
  })
);

const restartEntry = Schema.encodeSync(
  Schema.fromJsonString(JournalRecordSchema)
)({
  _tag: "EventReceived",
  eventId,
  restart: { coveredEventIds: [eventId, "later"], newEventIds: ["later"] },
});

const asEntry = (record: JournalEntry["record"]): JournalEntry => ({
  sequence: 1,
  ownerId: "owner" as JournalEntry["ownerId"],
  recordedAt: "2026-11-21T00:00:00.000Z",
  record,
});

describe("The restart record on a version that does not know restarts", () => {
  it("is stored as an EventReceived Entry that the earlier schema decodes as a plain EventReceived", () => {
    const earlierRead = Schema.decodeUnknownSync(earlierRecord)(restartEntry);

    expect(earlierRead).toEqual({ _tag: "EventReceived", eventId });
  });

  it("leaves the Delivery state Unsent and links no Turn, so recovery neither blocks nor settles an Event", () => {
    const earlierRead = Schema.decodeUnknownSync(earlierRecord)(restartEntry);
    const entries = [
      asEntry({ _tag: "EventReceived", eventId }),
      asEntry(earlierRead),
    ];

    expect(deliveryStateOfEntries(entries)).toEqual({ _tag: "Unsent" });
    expect(answeringTurnEventIdOf(entries)).toBeUndefined();
  });

  it("keeps the restart field out of the Trace that the earlier schema reads", () => {
    const earlierFields = Object.fromEntries(
      Object.entries(ReplyTurnTraceSchema.fields).filter(
        ([name]) => name !== "restart"
      )
    );
    const trace = Schema.encodeSync(ReplyTurnTraceSchema)({
      eventId,
      result: "model_replied",
      task: "reply",
      modelId: "m",
      modelSettings: { attempts: 1, attemptTimeoutMillis: 1 },
      system: "s",
      messages: [],
      steps: [],
      reply: "r",
      error: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        costUsd: null,
      },
      modelLatencyMillis: 1,
      outcome: null,
      refusedOutcomeTools: [],
      restart: { coveredEventIds: [eventId], newEventIds: ["later"] },
    });

    const earlierRead = Schema.decodeUnknownSync(Schema.Struct(earlierFields))(
      trace
    );

    expect(earlierRead).toMatchObject({ eventId, result: "model_replied" });
  });
});
