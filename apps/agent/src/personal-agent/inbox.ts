import { asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { ownerMessageFields, scheduleFiredFields } from "../event.ts";
import type { Event, OwnerMessage, ScheduleFired } from "../event.ts";
import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "./agent-storage.ts";
import { inboxEvents, inboxStates } from "./storage-schema.ts";

const inboxFields = {
  eventId: Schema.String,
  state: Schema.Literals(inboxStates),
};

export const InboxEventSchema = Schema.TaggedUnion({
  OwnerMessage: {
    ...ownerMessageFields,
    ...inboxFields,
  },
  ScheduleFired: {
    ...scheduleFiredFields,
    ...inboxFields,
  },
});

export type InboxEvent = typeof InboxEventSchema.Type;

export type OwnerMessageEvent = Extract<InboxEvent, { _tag: "OwnerMessage" }>;

export type StoreResult = "stored" | "duplicate";

const decodeInboxEvent = Schema.decodeUnknownSync(InboxEventSchema);

const withoutNulls = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

const toInboxEvent = (row: typeof inboxEvents.$inferSelect): InboxEvent =>
  decodeInboxEvent({
    ...withoutNulls(row),
    _tag: row.kind,
  });

const ownerMessagesFirst = sql`CASE ${inboxEvents.kind} WHEN 'OwnerMessage' THEN 0 ELSE 1 END`;

const stored = () =>
  ({
    eventId: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    state: "pending",
  }) as const;

const makeInbox = Effect.gen(function* makeInboxEffect() {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const insertOwnerMessage = ({ _tag, ...message }: OwnerMessage) =>
    database
      .insert(inboxEvents)
      .values({ ...stored(), kind: _tag, ...message })
      .onConflictDoNothing({
        target: [inboxEvents.channel, inboxEvents.channelUpdateId],
      })
      .returning({ eventId: inboxEvents.eventId });

  const insertScheduleFired = ({ _tag, ...fired }: ScheduleFired) =>
    database
      .insert(inboxEvents)
      .values({ ...stored(), kind: _tag, ...fired })
      .onConflictDoNothing({
        target: [inboxEvents.scheduleId, inboxEvents.dueAt],
      })
      .returning({ eventId: inboxEvents.eventId });

  const insert = (event: Event) =>
    (event._tag === "OwnerMessage"
      ? insertOwnerMessage(event)
      : insertScheduleFired(event)
    ).pipe(Effect.map((rows) => rows.at(0)?.eventId));

  const store = (event: Event) =>
    Effect.gen(function* storeEffect() {
      const eventId = yield* insert(event);
      if (eventId === undefined) {
        return "duplicate" satisfies StoreResult;
      }
      yield* journal.append({ _tag: "EventReceived", eventId });
      return "stored" satisfies StoreResult;
    });

  const pending = database
    .select()
    .from(inboxEvents)
    .where(eq(inboxEvents.state, "pending"))
    .orderBy(ownerMessagesFirst, asc(inboxEvents.sequence))
    .pipe(Effect.map((rows) => rows.map(toInboxEvent)));

  const settle =
    (state: "done" | "failed") => (events: readonly InboxEvent[]) =>
      Effect.forEach(
        events,
        (event) =>
          database
            .update(inboxEvents)
            .set({ state })
            .where(eq(inboxEvents.eventId, event.eventId)),
        { discard: true }
      );

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
