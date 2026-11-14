CREATE TABLE `channel_identities` (
	`channel_identity` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	CONSTRAINT `fk_channel_identities_owner_id_owners_owner_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`owner_id`)
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`owner_id` text PRIMARY KEY,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "owners_status_check" CHECK("status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE `registration` (
	`singleton` integer PRIMARY KEY,
	`state` text NOT NULL,
	CONSTRAINT "registration_singleton_check" CHECK("singleton" = 1),
	CONSTRAINT "registration_state_check" CHECK("state" IN ('open', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `channel_identities_owner` ON `channel_identities` (`owner_id`);