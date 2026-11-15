CREATE TABLE `conversation_recorded_events` (
	`event_id` text PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `turn_model_steps` (
	`event_id` text NOT NULL,
	`model_step_key` integer NOT NULL,
	CONSTRAINT `turn_model_steps_pk` PRIMARY KEY(`event_id`, `model_step_key`)
);
--> statement-breakpoint
CREATE TABLE `turn_progress` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL,
	`message` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_progress_event` ON `turn_progress` (`event_id`);