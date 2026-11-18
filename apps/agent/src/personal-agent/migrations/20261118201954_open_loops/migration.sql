-- ALTER TABLE ADD COLUMN, not a table rebuild: dropping `notes` would delete its note_links rows (ON DELETE CASCADE) and its full-text triggers.
-- The checks sit on the new columns. The last column holds the check that ties all four together.
ALTER TABLE `notes` ADD `open_loop_kind` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `open_loop_due_at` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `open_loop_state` text CONSTRAINT "notes_open_loop_state_check" CHECK(`open_loop_state` IS NULL OR `open_loop_state` IN ('open', 'closed'));--> statement-breakpoint
ALTER TABLE `notes` ADD `open_loop_close_reason` text CONSTRAINT "notes_open_loop_columns_check" CHECK((`open_loop_close_reason` IS NULL OR `open_loop_close_reason` IN ('done', 'dropped', 'replaced')) AND ((`open_loop_state` IS NULL AND `open_loop_kind` IS NULL AND `open_loop_due_at` IS NULL AND `open_loop_close_reason` IS NULL) OR (`open_loop_state` IS 'open' AND `open_loop_kind` IS NOT NULL AND `open_loop_close_reason` IS NULL) OR (`open_loop_state` IS 'closed' AND `open_loop_kind` IS NOT NULL AND `open_loop_close_reason` IS NOT NULL)));--> statement-breakpoint
CREATE INDEX `notes_open_loops` ON `notes` (`owner_id`,`open_loop_state`);
