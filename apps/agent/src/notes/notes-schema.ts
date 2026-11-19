import { sql } from "drizzle-orm";
import {
  check,
  index,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import type { OwnerMessage } from "../event.ts";
import type { OwnerId } from "../owner-id.ts";

export const trustLevels = ["owner", "untrusted"] as const;

export const noteChanges = ["text", "links", "text_and_links"] as const;

export const openLoopStates = ["open", "closed"] as const;

export const openLoopClosedReasons = ["done", "dropped", "replaced"] as const;

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
    openLoopKind: text("open_loop_kind"),
    openLoopState: text("open_loop_state", { enum: openLoopStates }),
    openLoopClosedReason: text("open_loop_closed_reason", {
      enum: openLoopClosedReasons,
    }),
    openLoopDueAt: text("open_loop_due_at"),
  },
  (table) => [
    unique().on(table.sourceEventId, table.textHash),
    index("notes_open_loops").on(table.openLoopState, table.openLoopDueAt),
    check("notes_trust_level_check", valueIn(table.trustLevel, trustLevels)),
    check(
      "notes_open_loop_state_check",
      valueIn(table.openLoopState, openLoopStates)
    ),
    check(
      "notes_open_loop_closed_reason_check",
      valueIn(table.openLoopClosedReason, openLoopClosedReasons)
    ),
    check(
      "notes_open_loop_check",
      sql`(${table.openLoopKind} IS NULL AND ${table.openLoopState} IS NULL AND ${table.openLoopClosedReason} IS NULL AND ${table.openLoopDueAt} IS NULL) OR (${table.openLoopKind} IS NOT NULL AND trim(${table.openLoopKind}) <> '' AND ${table.openLoopState} IS 'open' AND ${table.openLoopClosedReason} IS NULL) OR (${table.openLoopKind} IS NOT NULL AND trim(${table.openLoopKind}) <> '' AND ${table.openLoopState} IS 'closed' AND ${table.openLoopClosedReason} IS NOT NULL)`
    ),
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
