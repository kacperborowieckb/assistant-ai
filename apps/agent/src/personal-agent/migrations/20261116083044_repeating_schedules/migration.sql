ALTER TABLE `schedules` ADD `recurrence` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `recurrence_time_zone` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_schedules` (
	`schedule_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`set_by` text NOT NULL,
	`text` text NOT NULL,
	`note_id` text,
	`next_due_at` text NOT NULL,
	`recurrence` text,
	`recurrence_time_zone` text,
	`state` text NOT NULL,
	`source_event_id` text NOT NULL,
	`request_key` text NOT NULL,
	`created_at` text NOT NULL,
	`changed_at` text NOT NULL,
	CONSTRAINT `fk_schedules_note_id_notes_note_id_fk` FOREIGN KEY (`note_id`) REFERENCES `notes`(`note_id`),
	CONSTRAINT `schedules_source_event_id_request_key_unique` UNIQUE(`source_event_id`,`request_key`),
	CONSTRAINT "schedules_kind_check" CHECK("kind" IN ('reminder')),
	CONSTRAINT "schedules_set_by_check" CHECK("set_by" IN ('owner', 'agent')),
	CONSTRAINT "schedules_state_check" CHECK("state" IN ('active', 'done', 'cancelled')),
	CONSTRAINT "schedules_recurrence_check" CHECK(("recurrence" IS NULL) = ("recurrence_time_zone" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_schedules`(`schedule_id`, `owner_id`, `kind`, `set_by`, `text`, `note_id`, `next_due_at`, `state`, `source_event_id`, `request_key`, `created_at`, `changed_at`) SELECT `schedule_id`, `owner_id`, `kind`, `set_by`, `text`, `note_id`, `next_due_at`, `state`, `source_event_id`, `request_key`, `created_at`, `changed_at` FROM `schedules`;--> statement-breakpoint
DROP TABLE `schedules`;--> statement-breakpoint
ALTER TABLE `__new_schedules` RENAME TO `schedules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `schedules_state_due` ON `schedules` (`state`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `schedules_note` ON `schedules` (`note_id`);