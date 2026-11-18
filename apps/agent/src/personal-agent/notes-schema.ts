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

export const openLoopStates = ["open", "closed"] as const;

export const openLoopCloseReasons = ["done", "dropped", "replaced"] as const;

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
    openLoopDueAt: text("open_loop_due_at"),
    openLoopState: text("open_loop_state", { enum: openLoopStates }),
    openLoopCloseReason: text("open_loop_close_reason", {
      enum: openLoopCloseReasons,
    }),
  },
  (table) => [
    unique().on(table.sourceEventId, table.textHash),
    index("notes_open_loops").on(table.ownerId, table.openLoopState),
    check("notes_trust_level_check", valueIn(table.trustLevel, trustLevels)),
    check(
      "notes_open_loop_state_check",
      sql`${table.openLoopState} IS NULL OR ${valueIn(table.openLoopState, openLoopStates)}`
    ),
    check(
      "notes_open_loop_close_reason_check",
      sql`${table.openLoopCloseReason} IS NULL OR ${valueIn(table.openLoopCloseReason, openLoopCloseReasons)}`
    ),
    check(
      "notes_open_loop_columns_check",
      sql`(${table.openLoopState} IS NULL AND ${table.openLoopKind} IS NULL AND ${table.openLoopDueAt} IS NULL AND ${table.openLoopCloseReason} IS NULL) OR (${table.openLoopState} IS 'open' AND ${table.openLoopKind} IS NOT NULL AND ${table.openLoopCloseReason} IS NULL) OR (${table.openLoopState} IS 'closed' AND ${table.openLoopKind} IS NOT NULL AND ${table.openLoopCloseReason} IS NOT NULL)`
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
