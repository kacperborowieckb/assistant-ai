CREATE TABLE `owner_preferences` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`source_event_id` text NOT NULL,
	`changed_at` text NOT NULL,
	CONSTRAINT "owner_preferences_key_check" CHECK("key" IN ('time_zone'))
);
