CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`project_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_id` text,
	`model_row_id` text,
	`model_label` text DEFAULT '' NOT NULL,
	`prompt` text NOT NULL,
	`params` text,
	`provider_job_id` text,
	`file_name` text,
	`mime_type` text,
	`size_bytes` integer,
	`duration_seconds` real,
	`error` text,
	`estimated_cost` real,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `project_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`model_row_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `media_assets_user_idx` ON `media_assets` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_assets_project_idx` ON `media_assets` (`project_id`);--> statement-breakpoint
ALTER TABLE `models` ADD `price_per_image` real;--> statement-breakpoint
ALTER TABLE `models` ADD `price_per_second` real;--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `kind` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `media_options` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `image_model_row_id` text REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `projects` ADD `video_model_row_id` text REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `projects` ADD `max_media` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `media_api` text DEFAULT 'auto' NOT NULL;