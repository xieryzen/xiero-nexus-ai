CREATE TABLE `project_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`server_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_servers_unique` ON `project_servers` (`project_id`,`server_id`);--> statement-breakpoint
CREATE INDEX `project_servers_server_idx` ON `project_servers` (`server_id`);--> statement-breakpoint
CREATE TABLE `server_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`server_name` text NOT NULL,
	`kind` text DEFAULT 'command' NOT NULL,
	`project_id` text,
	`project_title` text,
	`run_id` text,
	`task_id` text,
	`task_title` text,
	`agent_name` text,
	`user_id` text,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`signal` text,
	`output` text,
	`output_bytes` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `server_commands_server_idx` ON `server_commands` (`server_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `server_commands_task_idx` ON `server_commands` (`task_id`);--> statement-breakpoint
CREATE INDEX `server_commands_run_idx` ON `server_commands` (`run_id`);--> statement-breakpoint
CREATE INDEX `server_commands_time_idx` ON `server_commands` (`created_at`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`auth_type` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`passphrase_ciphertext` text,
	`host_key` text NOT NULL,
	`access` text DEFAULT 'owners' NOT NULL,
	`status` text DEFAULT 'enabled' NOT NULL,
	`notes` text,
	`last_connected_at` integer,
	`last_error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_unique` ON `servers` (`name`);