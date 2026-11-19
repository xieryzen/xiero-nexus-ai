CREATE TABLE `browser_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`account_name` text,
	`project_id` text,
	`project_title` text,
	`run_id` text,
	`task_id` text,
	`task_title` text,
	`agent_name` text,
	`user_id` text,
	`url` text,
	`detail` text,
	`status` text NOT NULL,
	`note` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `site_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `browser_actions_time_idx` ON `browser_actions` (`created_at`);--> statement-breakpoint
CREATE INDEX `browser_actions_task_idx` ON `browser_actions` (`task_id`);--> statement-breakpoint
CREATE INDEX `browser_actions_run_idx` ON `browser_actions` (`run_id`);--> statement-breakpoint
CREATE INDEX `browser_actions_account_idx` ON `browser_actions` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_site_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`account_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `site_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_site_accounts_unique` ON `project_site_accounts` (`project_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `project_site_accounts_account_idx` ON `project_site_accounts` (`account_id`);--> statement-breakpoint
CREATE TABLE `site_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`site_url` text NOT NULL,
	`username` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`session_ciphertext` text,
	`session_saved_at` integer,
	`session_cookies` integer DEFAULT 0 NOT NULL,
	`access` text DEFAULT 'owners' NOT NULL,
	`status` text DEFAULT 'enabled' NOT NULL,
	`notes` text,
	`last_used_at` integer,
	`last_problem` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_accounts_name_unique` ON `site_accounts` (`name`);