CREATE TABLE `workspace_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`files` text NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workspace_snapshots_workspace_idx` ON `workspace_snapshots` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `review_notes` text;