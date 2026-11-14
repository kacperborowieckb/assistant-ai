import { Context, Effect, Layer, Schema } from "effect";

import { OwnerMessageSchema } from "../event.ts";
import type { OwnerMessage } from "../event.ts";
import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "./agent-storage.ts";

export const inboxSchema = [
  `CREATE TABLE IF NOT EXISTS inbox_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    channel TEXT NOT NULL,
    channel_update_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    channel_message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
    UNIQUE (channel, channel_update_id)
  )`,
  "CREATE INDEX IF NOT EXISTS inbox_events_state ON inbox_events (state, received_at)",
];

export const InboxEventSchema = Schema.Struct({
  eventId: Schema.String,
  ...OwnerMessageSchema.fields,
  state: Schema.Literals(["pending", "done", "failed"]),
});

export type InboxEvent = typeof InboxEventSchema.Type;

export type StoreResult = "stored" | "duplicate";

const EventRowSchema = Schema.Struct({
  event_id: Schema.String,
  channel: OwnerMessageSchema.fields.channel,
  channel_update_id: Schema.String,
  conversation_id: Schema.String,
  channel_message_id: Schema.String,
  text: Schema.String,
  sent_at: Schema.String,
  state: InboxEventSchema.fields.state,
});

const toInboxEvent = (row: typeof EventRowSchema.Type): InboxEvent => ({
  eventId: row.event_id,
  channel: row.channel,
  channelUpdateId: row.channel_update_id,
  conversationId: row.conversation_id,
  channelMessageId: row.channel_message_id,
  text: row.text,
  sentAt: row.sent_at,
  state: row.state,
});

const decodeEventRows = Schema.decodeUnknownSync(Schema.Array(EventRowSchema));

const makeInbox = Effect.gen(function* makeInboxEffect() {
  const { sql } = yield* AgentStorage;
  const journal = yield* Journal;

  const insert = (message: OwnerMessage) =>
    Effect.sync(
      () =>
        sql
          .exec<{ event_id: string }>(
            `INSERT INTO inbox_events
            (event_id, channel, channel_update_id, conversation_id, channel_message_id, text, sent_at, received_at, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
           ON CONFLICT (channel, channel_update_id) DO NOTHING
           RETURNING event_id`,
            crypto.randomUUID(),
            message.channel,
            message.channelUpdateId,
            message.conversationId,
            message.channelMessageId,
            message.text,
            message.sentAt,
            new Date().toISOString()
          )
          .toArray()
          .at(0)?.event_id
    );

  const store = (message: OwnerMessage) =>
    Effect.gen(function* storeEffect() {
      const eventId = yield* insert(message);
      if (eventId === undefined) {
        return "duplicate" satisfies StoreResult;
      }
      yield* journal.append({ _tag: "EventReceived", eventId });
      return "stored" satisfies StoreResult;
    });

  const pending = Effect.sync(() =>
    decodeEventRows(
      sql
        .exec(
          `SELECT event_id, channel, channel_update_id, conversation_id, channel_message_id, text, sent_at, state
           FROM inbox_events WHERE state = 'pending' ORDER BY received_at, rowid`
        )
        .toArray()
    ).map(toInboxEvent)
  );

  const settle =
    (state: "done" | "failed") => (events: readonly InboxEvent[]) =>
      Effect.sync(() => {
        for (const event of events) {
          sql.exec(
            "UPDATE inbox_events SET state = ? WHERE event_id = ?",
            state,
            event.eventId
          );
        }
      });

  return {
    store,
    pending,
    markDone: settle("done"),
    markFailed: settle("failed"),
  };
});

export class Inbox extends Context.Service<
  Inbox,
  Effect.Success<typeof makeInbox>
>()("Inbox") {
  static readonly layer = Layer.effect(Inbox, makeInbox);
}
