import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import type { OwnerMessage } from "../event.ts";
import type { OwnerId } from "../owner-id.ts";

export const inboxEvents = sqliteTable(
  "inbox_events",
  {
    eventId: text("event_id").primaryKey().notNull(),
    channel: text("channel").$type<OwnerMessage["channel"]>().notNull(),
    channelUpdateId: text("channel_update_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    channelMessageId: text("channel_message_id").notNull(),
    text: text("text").notNull(),
    sentAt: text("sent_at").notNull(),
    receivedAt: text("received_at").notNull(),
    state: text("state", { enum: ["pending", "done", "failed"] }).notNull(),
  },
  (table) => [
    unique().on(table.channel, table.channelUpdateId),
    index("inbox_events_state").on(table.state, table.receivedAt),
    check(
      "inbox_events_state_check",
      sql`${table.state} IN ('pending', 'done', 'failed')`
    ),
  ]
);

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    role: text("role", { enum: ["owner", "agent"] }).notNull(),
    text: text("text").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    check(
      "conversation_messages_role_check",
      sql`${table.role} IN ('owner', 'agent')`
    ),
  ]
);

export const journalEntries = sqliteTable("journal_entries", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").$type<OwnerId>().notNull(),
  recordedAt: text("recorded_at").notNull(),
  kind: text("kind").notNull(),
  eventId: text("event_id").notNull(),
  record: text("record").notNull(),
});

export const modelUsage = sqliteTable("model_usage", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").$type<OwnerId>().notNull(),
  recordedAt: text("recorded_at").notNull(),
  task: text("task", { enum: ["reply"] }).notNull(),
  modelId: text("model_id").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  costUsd: real("cost_usd"),
});
