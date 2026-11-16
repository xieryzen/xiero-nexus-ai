CREATE TABLE `agent_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_skills_unique` ON `agent_skills` (`agent_id`,`skill_id`);--> statement-breakpoint
CREATE INDEX `agent_skills_skill_idx` ON `agent_skills` (`skill_id`);--> statement-breakpoint
CREATE TABLE `skill_files` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_files_unique` ON `skill_files` (`skill_id`,`path`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`source_name` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name_key`);--> statement-breakpoint
CREATE TABLE `team_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`skill_id` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_skills_unique` ON `team_skills` (`team_id`,`skill_id`);--> statement-breakpoint
CREATE INDEX `team_skills_skill_idx` ON `team_skills` (`skill_id`);