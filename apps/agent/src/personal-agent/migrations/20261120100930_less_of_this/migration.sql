PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_turn_traces` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`event_id` text NOT NULL,
	`result` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT "turn_traces_result_check" CHECK("result" IN ('model_replied', 'model_failed', 'reminder_delivered', 'reminder_delivery_failed', 'scheduled_task_replied', 'scheduled_task_failed', 'scheduled_task_skipped', 'proactive_message_sent', 'proactive_message_failed', 'proactive_message_held', 'proactive_message_folded'))
);
--> statement-breakpoint
INSERT INTO `__new_turn_traces`(`sequence`, `owner_id`, `recorded_at`, `event_id`, `result`, `record`) SELECT `sequence`, `owner_id`, `recorded_at`, `event_id`, `result`, `record` FROM `turn_traces`;--> statement-breakpoint
DROP TABLE `turn_traces`;--> statement-breakpoint
ALTER TABLE `__new_turn_traces` RENAME TO `turn_traces`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_owner_preferences` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`source` text DEFAULT 'owner' NOT NULL,
	`source_event_id` text NOT NULL,
	`changed_at` text NOT NULL,
	CONSTRAINT "owner_preferences_key_check" CHECK("key" IN ('time_zone', 'quiet_hours', 'muted_proactive_messages'))
);
--> statement-breakpoint
INSERT INTO `__new_owner_preferences`(`key`, `value`, `source`, `source_event_id`, `changed_at`) SELECT `key`, `value`, `source`, `source_event_id`, `changed_at` FROM `owner_preferences`;--> statement-breakpoint
DROP TABLE `owner_preferences`;--> statement-breakpoint
ALTER TABLE `__new_owner_preferences` RENAME TO `owner_preferences`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `turn_traces_event` ON `turn_traces` (`event_id`);