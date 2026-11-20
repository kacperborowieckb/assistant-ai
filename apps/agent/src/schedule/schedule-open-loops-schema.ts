import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { notes, schedules } from "../personal-agent/storage-schema.ts";

export const scheduleOpenLoops = sqliteTable(
  "schedule_open_loops",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.scheduleId),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.noteId),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleId, table.noteId] }),
    index("schedule_open_loops_note").on(table.noteId),
  ]
);
