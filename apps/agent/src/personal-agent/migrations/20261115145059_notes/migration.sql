CREATE TABLE `notes` (
	`note_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`text` text NOT NULL,
	`url` text,
	`source_event_id` text NOT NULL,
	`source_channel` text NOT NULL,
	`source_conversation_id` text NOT NULL,
	`source_channel_message_id` text NOT NULL,
	`trust_level` text NOT NULL,
	`text_hash` text NOT NULL,
	`captured_at` text NOT NULL,
	`last_checked_at` text NOT NULL,
	CONSTRAINT `notes_source_event_id_text_hash_unique` UNIQUE(`source_event_id`,`text_hash`),
	CONSTRAINT "notes_trust_level_check" CHECK("trust_level" IN ('owner', 'untrusted'))
);
