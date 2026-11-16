import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import type { OwnerMessage } from "../event.ts";
import type { OwnerId } from "../owner-id.ts";

export const eventKinds = ["OwnerMessage", "ScheduleFired"] as const;

export const inboxStates = ["pending", "done", "failed"] as const;

export const trustLevels = ["owner", "untrusted"] as const;

export const noteChanges = ["text", "links", "text_and_links"] as const;

export const profileEntryKinds = ["fact", "style_rule"] as const;

export const ownerPreferenceKeys = ["time_zone"] as const;

export const turnResults = ["model_replied", "model_failed"] as const;

export const modelTasks = ["reply", "eval_judge"] as const;

export const inboxEvents = sqliteTable(
  "inbox_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull().unique(),
    kind: text("kind", { enum: eventKinds }).notNull().default("OwnerMessage"),
    channel: text("channel").$type<OwnerMessage["channel"]>(),
    channelUpdateId: text("channel_update_id"),
    conversationId: text("conversation_id"),
    channelMessageId: text("channel_message_id"),
    text: text("text"),
    forwardOrigin: text("forward_origin"),
    sentAt: text("sent_at"),
    scheduleId: text("schedule_id"),
    dueAt: text("due_at"),
    receivedAt: text("received_at").notNull(),
    state: text("state", { enum: inboxStates }).notNull(),
  },
  (table) => [
    unique().on(table.channel, table.channelUpdateId),
    unique().on(table.scheduleId, table.dueAt),
    index("inbox_events_state").on(table.state, table.receivedAt),
    check("inbox_events_state_check", valueIn(table.state, inboxStates)),
    check("inbox_events_kind_check", valueIn(table.kind, eventKinds)),
    check(
      "inbox_events_fields_check",
      sql`(${table.kind} = 'OwnerMessage' AND ${table.channel} IS NOT NULL AND ${table.channelUpdateId} IS NOT NULL AND ${table.conversationId} IS NOT NULL AND ${table.channelMessageId} IS NOT NULL AND ${table.text} IS NOT NULL AND ${table.sentAt} IS NOT NULL AND ${table.scheduleId} IS NULL AND ${table.dueAt} IS NULL) OR (${table.kind} = 'ScheduleFired' AND ${table.scheduleId} IS NOT NULL AND ${table.dueAt} IS NOT NULL AND ${table.channel} IS NULL AND ${table.channelUpdateId} IS NULL AND ${table.conversationId} IS NULL AND ${table.channelMessageId} IS NULL AND ${table.text} IS NULL AND ${table.forwardOrigin} IS NULL AND ${table.sentAt} IS NULL)`
    ),
  ]
);

export const ownerChannelConversations = sqliteTable(
  "owner_channel_conversations",
  {
    slot: integer("slot").primaryKey(),
    channel: text("channel").$type<OwnerMessage["channel"]>().notNull(),
    conversationId: text("conversation_id").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    check("owner_channel_conversations_one_row", sql`${table.slot} = 0`),
  ]
);

export const conversationMessages = sqliteTable("conversation_messages", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  message: text("message").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

export const turnProgress = sqliteTable(
  "turn_progress",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    message: text("message").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [index("turn_progress_event").on(table.eventId)]
);

export const turnModelSteps = sqliteTable(
  "turn_model_steps",
  {
    eventId: text("event_id").notNull(),
    modelStepKey: integer("model_step_key").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.modelStepKey] })]
);

export const conversationRecordedEvents = sqliteTable(
  "conversation_recorded_events",
  { eventId: text("event_id").primaryKey() }
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
  task: text("task", { enum: modelTasks }).notNull(),
  modelId: text("model_id").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  costUsd: real("cost_usd"),
});

export const turnTraces = sqliteTable(
  "turn_traces",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id").$type<OwnerId>().notNull(),
    recordedAt: text("recorded_at").notNull(),
    eventId: text("event_id").notNull(),
    result: text("result", { enum: turnResults }).notNull(),
    record: text("record").notNull(),
  },
  (table) => [
    index("turn_traces_event").on(table.eventId),
    check("turn_traces_result_check", valueIn(table.result, turnResults)),
  ]
);

export const notes = sqliteTable(
  "notes",
  {
    noteId: text("note_id").primaryKey(),
    ownerId: text("owner_id").$type<OwnerId>().notNull(),
    text: text("text").notNull(),
    url: text("url"),
    sourceEventId: text("source_event_id").notNull(),
    sourceChannel: text("source_channel")
      .$type<OwnerMessage["channel"]>()
      .notNull(),
    sourceConversationId: text("source_conversation_id").notNull(),
    sourceChannelMessageId: text("source_channel_message_id").notNull(),
    sourceForwardOrigin: text("source_forward_origin"),
    trustLevel: text("trust_level", { enum: trustLevels }).notNull(),
    textHash: text("text_hash").notNull(),
    capturedAt: text("captured_at").notNull(),
    lastCheckedAt: text("last_checked_at").notNull(),
  },
  (table) => [
    unique().on(table.sourceEventId, table.textHash),
    check("notes_trust_level_check", valueIn(table.trustLevel, trustLevels)),
  ]
);

export const noteLinks = sqliteTable(
  "note_links",
  {
    fromNoteId: text("from_note_id")
      .notNull()
      .references(() => notes.noteId, { onDelete: "cascade" }),
    toNoteId: text("to_note_id")
      .notNull()
      .references(() => notes.noteId, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fromNoteId, table.toNoteId] }),
    index("note_links_to_note").on(table.toNoteId),
    check(
      "note_links_ordered_check",
      sql`${table.fromNoteId} < ${table.toNoteId}`
    ),
  ]
);

export const profileEntries = sqliteTable(
  "profile_entries",
  {
    entryId: text("entry_id").primaryKey(),
    ownerId: text("owner_id").$type<OwnerId>().notNull(),
    kind: text("kind", { enum: profileEntryKinds }).notNull(),
    text: text("text").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    addedAt: text("added_at").notNull(),
  },
  (table) => [
    unique().on(table.kind, table.text),
    check("profile_entries_kind_check", valueIn(table.kind, profileEntryKinds)),
  ]
);

export const ownerPreferences = sqliteTable(
  "owner_preferences",
  {
    key: text("key", { enum: ownerPreferenceKeys }).primaryKey(),
    value: text("value").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    changedAt: text("changed_at").notNull(),
  },
  (table) => [
    check(
      "owner_preferences_key_check",
      valueIn(table.key, ownerPreferenceKeys)
    ),
  ]
);
