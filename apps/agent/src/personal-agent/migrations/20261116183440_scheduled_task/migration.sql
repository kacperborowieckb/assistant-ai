PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_turn_traces` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`event_id` text NOT NULL,
	`result` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT "turn_traces_result_check" CHECK("result" IN ('model_replied', 'model_failed', 'reminder_delivered', 'reminder_delivery_failed', 'scheduled_task_replied', 'scheduled_task_failed'))
);
--> statement-breakpoint
INSERT INTO `__new_turn_traces`(`sequence`, `owner_id`, `recorded_at`, `event_id`, `result`, `record`) SELECT `sequence`, `owner_id`, `recorded_at`, `event_id`, `result`, `record` FROM `turn_traces`;--> statement-breakpoint
DROP TABLE `turn_traces`;--> statement-breakpoint
ALTER TABLE `__new_turn_traces` RENAME TO `turn_traces`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `turn_traces_event` ON `turn_traces` (`event_id`);--> statement-breakpoint
CREATE TRIGGER turn_traces_no_update
BEFORE UPDATE ON turn_traces
BEGIN SELECT RAISE(ABORT, 'Traces are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER turn_traces_no_delete
BEFORE DELETE ON turn_traces
BEGIN SELECT RAISE(ABORT, 'Traces are append-only'); END;
