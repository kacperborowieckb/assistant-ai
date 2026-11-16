CREATE TABLE `schedules` (
	`schedule_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`set_by` text NOT NULL,
	`text` text NOT NULL,
	`note_id` text,
	`next_due_at` text NOT NULL,
	`state` text NOT NULL,
	`source_event_id` text NOT NULL,
	`request_key` text NOT NULL,
	`created_at` text NOT NULL,
	`changed_at` text NOT NULL,
	CONSTRAINT `fk_schedules_note_id_notes_note_id_fk` FOREIGN KEY (`note_id`) REFERENCES `notes`(`note_id`) ON DELETE CASCADE,
	CONSTRAINT `schedules_source_event_id_request_key_unique` UNIQUE(`source_event_id`,`request_key`),
	CONSTRAINT "schedules_kind_check" CHECK("kind" IN ('reminder')),
	CONSTRAINT "schedules_set_by_check" CHECK("set_by" IN ('owner', 'agent')),
	CONSTRAINT "schedules_state_check" CHECK("state" IN ('active', 'done', 'cancelled'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_turn_traces` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`event_id` text NOT NULL,
	`result` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT "turn_traces_result_check" CHECK("result" IN ('model_replied', 'model_failed', 'reminder_delivered', 'reminder_delivery_failed'))
);
--> statement-breakpoint
INSERT INTO `__new_turn_traces`(`sequence`, `owner_id`, `recorded_at`, `event_id`, `result`, `record`) SELECT `sequence`, `owner_id`, `recorded_at`, `event_id`, `result`, `record` FROM `turn_traces`;--> statement-breakpoint
DROP TABLE `turn_traces`;--> statement-breakpoint
ALTER TABLE `__new_turn_traces` RENAME TO `turn_traces`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `turn_traces_event` ON `turn_traces` (`event_id`);--> statement-breakpoint
CREATE INDEX `schedules_state_due` ON `schedules` (`state`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `schedules_note` ON `schedules` (`note_id`);--> statement-breakpoint
CREATE TRIGGER turn_traces_no_update
BEFORE UPDATE ON turn_traces
BEGIN SELECT RAISE(ABORT, 'Traces are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER turn_traces_no_delete
BEFORE DELETE ON turn_traces
BEGIN SELECT RAISE(ABORT, 'Traces are append-only'); END;
