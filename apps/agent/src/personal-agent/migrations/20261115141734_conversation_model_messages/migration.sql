PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`message` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_conversation_messages`(`sequence`, `message`, `recorded_at`) SELECT `sequence`, json_object('role', CASE `role` WHEN 'owner' THEN 'user' ELSE 'assistant' END, 'content', `text`), `recorded_at` FROM `conversation_messages`;--> statement-breakpoint
DROP TABLE `conversation_messages`;--> statement-breakpoint
ALTER TABLE `__new_conversation_messages` RENAME TO `conversation_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
