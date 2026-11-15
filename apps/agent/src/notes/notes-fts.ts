import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notesFts = sqliteTable("notes_fts", {
  noteId: text("note_id").notNull(),
  text: text("text").notNull(),
  url: text("url").notNull(),
});

export const matchesQuery = (match: string) => sql`${notesFts} MATCH ${match}`;

export const bestMatchFirst = sql`bm25(${notesFts})`;

export const ftsMatchOf = (query: string) => {
  const words = query.match(/[\p{L}\p{N}]+/gu);
  return words === null
    ? undefined
    : words.map((word) => `"${word}"`).join(" OR ");
};
