CREATE TABLE `built_files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`file_name` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`command` text NOT NULL,
	`source_hash` text NOT NULL,
	`task_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `built_files_path_unique` ON `built_files` (`project_id`,`path`);--> statement-breakpoint
ALTER TABLE `exec_runs` ADD `source_hash` text;