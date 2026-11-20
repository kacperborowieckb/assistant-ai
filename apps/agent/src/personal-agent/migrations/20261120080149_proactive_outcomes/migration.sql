ALTER TABLE `proactive_messages` ADD `sent_at` text;--> statement-breakpoint
ALTER TABLE `proactive_messages` ADD `window_ends_at` text;--> statement-breakpoint
ALTER TABLE `proactive_messages` ADD `connected_event_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_proactive_messages` (
	`event_id` text PRIMARY KEY,
	`sent_message_id` text,
	`open_loop_ids` text NOT NULL,
	`outcome` text,
	`planned_at` text NOT NULL,
	`sent_at` text,
	`window_ends_at` text,
	`connected_event_id` text UNIQUE,
	CONSTRAINT "proactive_messages_outcome_check" CHECK("outcome" IS NULL OR "outcome" IN ('acted', 'replied', 'muted', 'ignored')),
	CONSTRAINT "proactive_messages_outcome_sent_check" CHECK("outcome" IS NULL OR ("sent_message_id" IS NOT NULL AND "window_ends_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_proactive_messages`(`event_id`, `sent_message_id`, `open_loop_ids`, `outcome`, `planned_at`) SELECT `event_id`, `sent_message_id`, `open_loop_ids`, `outcome`, `planned_at` FROM `proactive_messages`;--> statement-breakpoint
DROP TABLE `proactive_messages`;--> statement-breakpoint
ALTER TABLE `__new_proactive_messages` RENAME TO `proactive_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;