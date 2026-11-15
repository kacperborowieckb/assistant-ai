CREATE TABLE `turn_traces` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`event_id` text NOT NULL,
	`result` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT "turn_traces_result_check" CHECK("result" IN ('replied', 'model_failed'))
);
--> statement-breakpoint
CREATE INDEX `turn_traces_event` ON `turn_traces` (`event_id`);