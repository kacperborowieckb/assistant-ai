CREATE TABLE `note_links` (
	`from_note_id` text NOT NULL,
	`to_note_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `note_links_pk` PRIMARY KEY(`from_note_id`, `to_note_id`),
	CONSTRAINT `fk_note_links_from_note_id_notes_note_id_fk` FOREIGN KEY (`from_note_id`) REFERENCES `notes`(`note_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_note_links_to_note_id_notes_note_id_fk` FOREIGN KEY (`to_note_id`) REFERENCES `notes`(`note_id`) ON DELETE CASCADE,
	CONSTRAINT "note_links_ordered_check" CHECK("from_note_id" < "to_note_id")
);
--> statement-breakpoint
CREATE INDEX `note_links_to_note` ON `note_links` (`to_note_id`);