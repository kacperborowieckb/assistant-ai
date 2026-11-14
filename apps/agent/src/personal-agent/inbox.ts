import { asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { OwnerMessageSchema } from "../event.ts";
import type { OwnerMessage } from "../event.ts";
import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "./agent-storage.ts";
import { inboxEvents } from "./storage-schema.ts";

export const InboxEventSchema = Schema.Struct({
  eventId: Schema.String,
  ...OwnerMessageSchema.fields,
  state: Schema.Literals(["pending", "done", "failed"]),
});

export type InboxEvent = typeof InboxEventSchema.Type;

export type StoreResult = "stored" | "duplicate";

const toInboxEvent = (row: typeof inboxEvents.$inferSelect): InboxEvent => ({
  eventId: row.eventId,
  channel: row.channel,
  channelUpdateId: row.channelUpdateId,
  conversationId: row.conversationId,
  channelMessageId: row.channelMessageId,
  text: row.text,
  sentAt: row.sentAt,
  state: row.state,
});

const makeInbox = Effect.gen(function* makeInboxEffect() {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const insert = (message: OwnerMessage) =>
    Effect.sync(
      () =>
        database
          .insert(inboxEvents)
          .values({
            eventId: crypto.randomUUID(),
            ...message,
            receivedAt: new Date().toISOString(),
            state: "pending",
          })
          .onConflictDoNothing({
            target: [inboxEvents.channel, inboxEvents.channelUpdateId],
          })
          .returning({ eventId: inboxEvents.eventId })
          .all()
          .at(0)?.eventId
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
    database
      .select()
      .from(inboxEvents)
      .where(eq(inboxEvents.state, "pending"))
      .orderBy(asc(inboxEvents.receivedAt), asc(sql`rowid`))
      .all()
      .map(toInboxEvent)
  );

  const settle =
    (state: "done" | "failed") => (events: readonly InboxEvent[]) =>
      Effect.sync(() => {
        for (const event of events) {
          database
            .update(inboxEvents)
            .set({ state })
            .where(eq(inboxEvents.eventId, event.eventId))
            .run();
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
