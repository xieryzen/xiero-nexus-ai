ALTER TABLE `users` ADD `token_limit` integer DEFAULT 10000000 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `tokens_used` integer DEFAULT 0 NOT NULL;