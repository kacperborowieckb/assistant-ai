CREATE TABLE `schedule_open_loops` (
	`schedule_id` text NOT NULL,
	`note_id` text NOT NULL,
	CONSTRAINT `schedule_open_loops_pk` PRIMARY KEY(`schedule_id`, `note_id`),
	CONSTRAINT `fk_schedule_open_loops_schedule_id_schedules_schedule_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`schedule_id`),
	CONSTRAINT `fk_schedule_open_loops_note_id_notes_note_id_fk` FOREIGN KEY (`note_id`) REFERENCES `notes`(`note_id`)
);
--> statement-breakpoint
CREATE INDEX `schedule_open_loops_note` ON `schedule_open_loops` (`note_id`);