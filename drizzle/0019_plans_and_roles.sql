CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `min_tier` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `position` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `plan` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `token_allowance` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `tokens_period` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `period_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- An account whose limit an owner had set keeps that number: it is its own
-- allowance for a month now. Ten million was what every account got, and is
-- what the FREE plan has: those accounts follow their role from here on.
UPDATE `users` SET `token_allowance` = `token_limit` WHERE `token_limit` <> 10000000 AND `role` <> 'owner';
