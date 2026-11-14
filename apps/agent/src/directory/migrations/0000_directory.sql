CREATE TABLE `channel_identities` (
	`channel_identity` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`owner_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `channel_identities_owner` ON `channel_identities` (`owner_id`);--> statement-breakpoint
CREATE TABLE `owners` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "owners_status_check" CHECK("owners"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE `registration` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT "registration_singleton_check" CHECK("registration"."singleton" = 1),
	CONSTRAINT "registration_state_check" CHECK("registration"."state" IN ('open', 'closed'))
);
