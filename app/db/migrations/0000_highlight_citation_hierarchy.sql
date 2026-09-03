-- Bootstrap the schema that predated tracked migrations. Existing installations
-- created these tables with `db:push`; conditional DDL makes this migration
-- usable for those installations, a partially upgraded database, and an empty
-- database without a Drizzle migration journal.
CREATE TABLE IF NOT EXISTS `book_digests` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`author` varchar(255) NOT NULL DEFAULT '',
	`structure` text NOT NULL,
	`overview` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `book_digests_id` PRIMARY KEY(`id`),
	CONSTRAINT `book_digests_content_hash_unique` UNIQUE(`content_hash`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `webhook_subscriptions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`url` varchar(1024) NOT NULL,
	`secret` varchar(255) NOT NULL DEFAULT '',
	`events` text NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`fail_count` int NOT NULL DEFAULT 0,
	`description` varchar(255) NOT NULL DEFAULT '',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `webhook_subscriptions_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_books` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ext_id` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`author` varchar(255) NOT NULL DEFAULT '',
	`format` varchar(16) NOT NULL DEFAULT 'unknown',
	`folder` varchar(255) NOT NULL DEFAULT '',
	`content_hash` varchar(64) NOT NULL DEFAULT '',
	`chapters` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mirror_books_id` PRIMARY KEY(`id`),
	CONSTRAINT `mirror_books_ext_id_unique` UNIQUE(`ext_id`),
	INDEX `idx_mirror_books_hash` (`content_hash`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_folders` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ext_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mirror_folders_id` PRIMARY KEY(`id`),
	CONSTRAINT `mirror_folders_ext_id_unique` UNIQUE(`ext_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_highlights` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ext_id` varchar(64) NOT NULL,
	`book_ext_id` varchar(64) NOT NULL DEFAULT '',
	`book_title` varchar(255) NOT NULL DEFAULT '',
	`chapter_title` varchar(255) NOT NULL DEFAULT '',
	`text` text NOT NULL,
	`style_kind` varchar(16) NOT NULL DEFAULT 'underline',
	`style_color` varchar(32) NOT NULL DEFAULT 'orange',
	`note` text,
	`note_ext_id` varchar(64) NOT NULL DEFAULT '',
	`ai_qa` text,
	`tags` text,
	`cloze` text,
	`review` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mirror_highlights_id` PRIMARY KEY(`id`),
	CONSTRAINT `mirror_highlights_ext_id_unique` UNIQUE(`ext_id`),
	INDEX `idx_mirror_hl_book` (`book_ext_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_mindmaps` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ext_id` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`book_ext_id` varchar(64) NOT NULL DEFAULT '',
	`book_title` varchar(255) NOT NULL DEFAULT '',
	`root` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mirror_mindmaps_id` PRIMARY KEY(`id`),
	CONSTRAINT `mirror_mindmaps_ext_id_unique` UNIQUE(`ext_id`),
	INDEX `idx_mirror_mindmaps_book` (`book_ext_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_notes` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ext_id` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`content` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mirror_notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `mirror_notes_ext_id_unique` UNIQUE(`ext_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_translations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ext_id` varchar(64) NOT NULL,
	`book_ext_id` varchar(64) NOT NULL DEFAULT '',
	`book_title` varchar(255) NOT NULL DEFAULT '',
	`chapter_title` varchar(255) NOT NULL DEFAULT '',
	`target_lang` varchar(32) NOT NULL,
	`scope` varchar(16) NOT NULL DEFAULT 'passage',
	`text` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mirror_translations_id` PRIMARY KEY(`id`),
	CONSTRAINT `mirror_translations_ext_id_unique` UNIQUE(`ext_id`),
	INDEX `idx_mirror_translations_book` (`book_ext_id`)
);--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `COLUMN_NAME` = 'citation_level'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_highlights` ADD `citation_level` varchar(16) DEFAULT ''content'' NOT NULL'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `COLUMN_NAME` = 'chapter_id'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_highlights` ADD `chapter_id` varchar(64) DEFAULT '''' NOT NULL'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `COLUMN_NAME` = 'para_index'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_highlights` ADD `para_index` int'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `COLUMN_NAME` = 'start_offset'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_highlights` ADD `start_offset` int'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `COLUMN_NAME` = 'end_offset'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_highlights` ADD `end_offset` int'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `COLUMN_NAME` = 'pdf_anchor'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_highlights` ADD `pdf_anchor` text'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`STATISTICS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `INDEX_NAME` = 'idx_mirror_hl_chapter'
	),
	'SELECT 1',
	'CREATE INDEX `idx_mirror_hl_chapter` ON `mirror_highlights` (`book_ext_id`,`chapter_id`)'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
