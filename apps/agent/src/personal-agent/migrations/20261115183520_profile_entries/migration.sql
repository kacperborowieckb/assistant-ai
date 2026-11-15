CREATE TABLE `profile_entries` (
	`entry_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`source_event_id` text NOT NULL,
	`added_at` text NOT NULL,
	CONSTRAINT `profile_entries_kind_text_unique` UNIQUE(`kind`,`text`),
	CONSTRAINT "profile_entries_kind_check" CHECK("kind" IN ('fact', 'style_rule'))
);
