import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { valueIn } from "../check-values.ts";
import { proactiveOutcomes } from "../personal-agent/storage-values.ts";

export const proactiveMessages = sqliteTable(
  "proactive_messages",
  {
    eventId: text("event_id").primaryKey(),
    sentMessageId: text("sent_message_id"),
    openLoopIds: text("open_loop_ids").notNull(),
    outcome: text("outcome", { enum: proactiveOutcomes }),
    plannedAt: text("planned_at").notNull(),
  },
  (table) => [
    check(
      "proactive_messages_outcome_check",
      sql`${table.outcome} IS NULL OR ${valueIn(table.outcome, proactiveOutcomes)}`
    ),
  ]
);
