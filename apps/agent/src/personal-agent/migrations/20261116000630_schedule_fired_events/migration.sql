CREATE TABLE `owner_channel_conversations` (
	`slot` integer PRIMARY KEY,
	`channel` text NOT NULL,
	`conversation_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "owner_channel_conversations_one_row" CHECK("slot" = 0)
);
--> statement-breakpoint
ALTER TABLE `inbox_events` ADD `kind` text DEFAULT 'OwnerMessage' NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox_events` ADD `schedule_id` text;--> statement-breakpoint
ALTER TABLE `inbox_events` ADD `due_at` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_inbox_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL UNIQUE,
	`kind` text DEFAULT 'OwnerMessage' NOT NULL,
	`channel` text,
	`channel_update_id` text,
	`conversation_id` text,
	`channel_message_id` text,
	`text` text,
	`forward_origin` text,
	`sent_at` text,
	`schedule_id` text,
	`due_at` text,
	`received_at` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `inbox_events_channel_channel_update_id_unique` UNIQUE(`channel`,`channel_update_id`),
	CONSTRAINT `inbox_events_schedule_id_due_at_unique` UNIQUE(`schedule_id`,`due_at`),
	CONSTRAINT "inbox_events_state_check" CHECK("state" IN ('pending', 'done', 'failed')),
	CONSTRAINT "inbox_events_kind_check" CHECK("kind" IN ('OwnerMessage', 'ScheduleFired')),
	CONSTRAINT "inbox_events_fields_check" CHECK(("kind" = 'OwnerMessage' AND "channel" IS NOT NULL AND "channel_update_id" IS NOT NULL AND "conversation_id" IS NOT NULL AND "channel_message_id" IS NOT NULL AND "text" IS NOT NULL AND "sent_at" IS NOT NULL AND "schedule_id" IS NULL AND "due_at" IS NULL) OR ("kind" = 'ScheduleFired' AND "schedule_id" IS NOT NULL AND "due_at" IS NOT NULL AND "channel" IS NULL AND "channel_update_id" IS NULL AND "conversation_id" IS NULL AND "channel_message_id" IS NULL AND "text" IS NULL AND "forward_origin" IS NULL AND "sent_at" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_inbox_events`(`sequence`, `event_id`, `channel`, `channel_update_id`, `conversation_id`, `channel_message_id`, `text`, `forward_origin`, `sent_at`, `received_at`, `state`) SELECT `sequence`, `event_id`, `channel`, `channel_update_id`, `conversation_id`, `channel_message_id`, `text`, `forward_origin`, `sent_at`, `received_at`, `state` FROM `inbox_events`;--> statement-breakpoint
DROP TABLE `inbox_events`;--> statement-breakpoint
ALTER TABLE `__new_inbox_events` RENAME TO `inbox_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `inbox_events_state` ON `inbox_events` (`state`,`received_at`);