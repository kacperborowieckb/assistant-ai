import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import { ownerPreferenceKeys } from "../personal-agent/storage-values.ts";

export const ownerPreferences = sqliteTable(
  "owner_preferences",
  {
    key: text("key", { enum: ownerPreferenceKeys }).primaryKey(),
    value: text("value").notNull(),
    source: text("source").notNull().default("owner"),
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
