ALTER TABLE `projects` ADD `max_tokens` integer DEFAULT 200000 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `max_tasks` integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `max_parallel` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `tokens_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `requires_approval` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `approved` integer DEFAULT false NOT NULL;