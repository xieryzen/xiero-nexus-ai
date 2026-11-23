CREATE TABLE `access_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`site` text,
	`secret_ciphertext` text NOT NULL,
	`hint` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'enabled' NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_keys_owner_name_unique` ON `access_keys` (`owner_id`,`name`);--> statement-breakpoint
CREATE TABLE `account_memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`source` text DEFAULT 'chat' NOT NULL,
	`chat_id` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `account_memories_user_idx` ON `account_memories` (`user_id`,`created_at`);--> statement-breakpoint
DROP TABLE `chat_messages`;--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`details` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_chat_idx` ON `chat_messages` (`chat_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `chats_user_idx`;--> statement-breakpoint
CREATE INDEX `chats_user_idx` ON `chats` (`user_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `servers` ADD `owner_id` text REFERENCES users(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `servers_owner_idx` ON `servers` (`owner_id`);--> statement-breakpoint
ALTER TABLE `site_accounts` ADD `owner_id` text REFERENCES users(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `site_accounts_owner_idx` ON `site_accounts` (`owner_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE `account_memories_fts` USING fts5(`content`, content='account_memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `account_memories_fts_insert` AFTER INSERT ON `account_memories` BEGIN
  INSERT INTO `account_memories_fts`(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER `account_memories_fts_delete` AFTER DELETE ON `account_memories` BEGIN
  INSERT INTO `account_memories_fts`(`account_memories_fts`, rowid, content) VALUES ('delete', old.id, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER `account_memories_fts_update` AFTER UPDATE OF `content` ON `account_memories` BEGIN
  INSERT INTO `account_memories_fts`(`account_memories_fts`, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO `account_memories_fts`(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `chat_messages_fts` USING fts5(`content`, content='chat_messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_insert` AFTER INSERT ON `chat_messages` BEGIN
  INSERT INTO `chat_messages_fts`(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_delete` AFTER DELETE ON `chat_messages` BEGIN
  INSERT INTO `chat_messages_fts`(`chat_messages_fts`, rowid, content) VALUES ('delete', old.id, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_update` AFTER UPDATE OF `content` ON `chat_messages` BEGIN
  INSERT INTO `chat_messages_fts`(`chat_messages_fts`, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO `chat_messages_fts`(rowid, content) VALUES (new.id, new.content);
END;
