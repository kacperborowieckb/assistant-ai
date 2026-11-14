CREATE TABLE `conversation_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "conversation_messages_role_check" CHECK("role" IN ('owner', 'agent'))
);
--> statement-breakpoint
CREATE TABLE `inbox_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL UNIQUE,
	`channel` text NOT NULL,
	`channel_update_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`channel_message_id` text NOT NULL,
	`text` text NOT NULL,
	`sent_at` text NOT NULL,
	`received_at` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `inbox_events_channel_channel_update_id_unique` UNIQUE(`channel`,`channel_update_id`),
	CONSTRAINT "inbox_events_state_check" CHECK("state" IN ('pending', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`kind` text NOT NULL,
	`event_id` text NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_usage` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`task` text NOT NULL,
	`model_id` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_input_tokens` integer,
	`cost_usd` real
);
--> statement-breakpoint
CREATE INDEX `inbox_events_state` ON `inbox_events` (`state`,`received_at`);