CREATE TABLE `turn_progress` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL,
	`message` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_progress_event` ON `turn_progress` (`event_id`);