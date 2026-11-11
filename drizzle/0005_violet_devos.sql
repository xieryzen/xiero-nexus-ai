CREATE TABLE `git_remotes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`host` text DEFAULT 'api.github.com' NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`token_ciphertext` text NOT NULL,
	`last4` text DEFAULT '' NOT NULL,
	`last_push_at` integer,
	`last_push_sha` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `git_remotes_project_unique` ON `git_remotes` (`project_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`steps` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `routing_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `required_capability` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `hard_qa_gate` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `workflow_id` text;