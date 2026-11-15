CREATE TABLE `agent_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`collection_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_knowledge_unique` ON `agent_knowledge` (`agent_id`,`collection_id`);--> statement-breakpoint
CREATE TABLE `agent_memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`project_id` text,
	`content` text NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_memories_agent_idx` ON `agent_memories` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`model_row_ids` text,
	`rate_limit_per_minute` integer,
	`monthly_token_limit` integer,
	`monthly_cost_limit` real,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer,
	`worker_id` text,
	`locked_at` integer,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`seq` integer NOT NULL,
	`content` text NOT NULL,
	`embedding` blob,
	`embedding_model_row_id` text,
	FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_chunks_collection_idx` ON `knowledge_chunks` (`collection_id`);--> statement-breakpoint
CREATE INDEX `knowledge_chunks_document_idx` ON `knowledge_chunks` (`document_id`,`seq`);--> statement-breakpoint
CREATE TABLE `knowledge_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`embedding_model_row_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`embedding_model_row_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `knowledge_collections_creator_idx` ON `knowledge_collections` (`created_by`);--> statement-breakpoint
CREATE TABLE `knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`title` text NOT NULL,
	`source_type` text NOT NULL,
	`source_name` text,
	`mime_type` text,
	`size_bytes` integer,
	`char_count` integer DEFAULT 0 NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`embedding_status` text DEFAULT 'none' NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `knowledge_documents_collection_idx` ON `knowledge_documents` (`collection_id`);--> statement-breakpoint
CREATE TABLE `notification_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`url` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_status` text,
	`last_error` text,
	`last_delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_webhooks_user_unique` ON `notification_webhooks` (`user_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`read_at` integer,
	`webhook_status` text DEFAULT 'none' NOT NULL,
	`webhook_attempts` integer DEFAULT 0 NOT NULL,
	`webhook_next_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_webhook_idx` ON `notifications` (`webhook_status`);--> statement-breakpoint
CREATE TABLE `project_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`schedule_id` text,
	`api_key_id` text,
	`requested_by` text,
	`input` text,
	`deliverable` text,
	`review_notes` text,
	`error` text,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`worker_id` text,
	`heartbeat_at` integer,
	`resumes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_runs_project_idx` ON `project_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_runs_status_idx` ON `project_runs` (`status`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`input` text,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_run_id` text,
	`last_status` text,
	`last_error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `schedules_project_idx` ON `schedules` (`project_id`);--> statement-breakpoint
CREATE INDEX `schedules_due_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text,
	`step` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`arguments` text,
	`result` text,
	`is_error` integer DEFAULT false NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `project_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tool_calls_task_idx` ON `tool_calls` (`task_id`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `steps` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `tool_call_count` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `tools` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `max_steps` integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `memory_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `source` text DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `api_key_id` text REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `models` ADD `price_per_mchars` real;--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `output_file` text;--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `steps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `tool_call_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `speech_model_row_id` text REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `projects` ADD `memory` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `config` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `api_key_id` text REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `usage_api_key_idx` ON `usage_records` (`api_key_id`,`created_at`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `knowledge_chunks_fts` USING fts5(`content`, content='knowledge_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_fts_insert` AFTER INSERT ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_chunks_fts`(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_fts_delete` AFTER DELETE ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_chunks_fts`(`knowledge_chunks_fts`, rowid, content) VALUES ('delete', old.id, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_fts_update` AFTER UPDATE OF `content` ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_chunks_fts`(`knowledge_chunks_fts`, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO `knowledge_chunks_fts`(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `agent_memories_fts` USING fts5(`content`, content='agent_memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `agent_memories_fts_insert` AFTER INSERT ON `agent_memories` BEGIN
  INSERT INTO `agent_memories_fts`(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER `agent_memories_fts_delete` AFTER DELETE ON `agent_memories` BEGIN
  INSERT INTO `agent_memories_fts`(`agent_memories_fts`, rowid, content) VALUES ('delete', old.id, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER `agent_memories_fts_update` AFTER UPDATE OF `content` ON `agent_memories` BEGIN
  INSERT INTO `agent_memories_fts`(`agent_memories_fts`, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO `agent_memories_fts`(rowid, content) VALUES (new.id, new.content);
END;
