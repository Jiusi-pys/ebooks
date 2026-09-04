-- Forward-only reconciliation for installations that already recorded 0005-0009
-- before those migration files gained restart and quarantine safeguards. Drizzle
-- does not replay an applied migration when its file hash changes.
CREATE TABLE IF NOT EXISTS `app_users` (
	`id` int NOT NULL,
	`username_encrypted` varchar(512) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`credential_version` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `app_users_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_books' AND `COLUMN_NAME` = 'metadata'), 'SELECT 1', 'ALTER TABLE `mirror_books` ADD `metadata` text');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_book_tombstones` (
	`ext_id` varchar(64) NOT NULL,
	`deleted_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mirror_book_tombstones_ext_id` PRIMARY KEY(`ext_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mirror_note_tombstones` (
	`ext_id` varchar(64) NOT NULL,
	`deleted_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mirror_note_tombstones_ext_id` PRIMARY KEY(`ext_id`)
);--> statement-breakpoint

-- Capture any rows that remain invalid before tightening the book references.
-- This cannot recover rows deleted by an older 0007; those require a backup/binlog.
CREATE TABLE IF NOT EXISTS `_migration_0007_orphan_highlights` LIKE `mirror_highlights`;--> statement-breakpoint
ALTER TABLE `_migration_0007_orphan_highlights` MODIFY COLUMN `note_ext_id` varchar(64);--> statement-breakpoint
INSERT IGNORE INTO `_migration_0007_orphan_highlights` SELECT h.* FROM `mirror_highlights` h LEFT JOIN `mirror_books` b ON b.`ext_id` = h.`book_ext_id` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_migration_0007_orphan_translations` LIKE `mirror_translations`;--> statement-breakpoint
INSERT IGNORE INTO `_migration_0007_orphan_translations` SELECT t.* FROM `mirror_translations` t LEFT JOIN `mirror_books` b ON b.`ext_id` = t.`book_ext_id` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_migration_0007_orphan_mindmaps` LIKE `mirror_mindmaps`;--> statement-breakpoint
INSERT IGNORE INTO `_migration_0007_orphan_mindmaps` SELECT m.* FROM `mirror_mindmaps` m LEFT JOIN `mirror_books` b ON b.`ext_id` = m.`book_ext_id` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_migration_0007_orphan_associations` LIKE `mirror_associations`;--> statement-breakpoint
INSERT IGNORE INTO `_migration_0007_orphan_associations` SELECT a.* FROM `mirror_associations` a LEFT JOIN `mirror_books` source_book ON source_book.`ext_id` = a.`source_book_ext_id` LEFT JOIN `mirror_books` target_book ON target_book.`ext_id` = a.`target_book_ext_id` WHERE source_book.`ext_id` IS NULL OR target_book.`ext_id` IS NULL;--> statement-breakpoint
DELETE h FROM `mirror_highlights` h LEFT JOIN `mirror_books` b ON b.`ext_id` = h.`book_ext_id` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
DELETE t FROM `mirror_translations` t LEFT JOIN `mirror_books` b ON b.`ext_id` = t.`book_ext_id` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
DELETE m FROM `mirror_mindmaps` m LEFT JOIN `mirror_books` b ON b.`ext_id` = m.`book_ext_id` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
DELETE a FROM `mirror_associations` a LEFT JOIN `mirror_books` source_book ON source_book.`ext_id` = a.`source_book_ext_id` LEFT JOIN `mirror_books` target_book ON target_book.`ext_id` = a.`target_book_ext_id` WHERE source_book.`ext_id` IS NULL OR target_book.`ext_id` IS NULL;--> statement-breakpoint

ALTER TABLE `book_digests` MODIFY COLUMN `structure` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `book_digests` MODIFY COLUMN `overview` longtext;--> statement-breakpoint
ALTER TABLE `mirror_associations` MODIFY COLUMN `source_text` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_associations` MODIFY COLUMN `target_text` longtext NOT NULL;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_highlights' AND `COLUMN_NAME` = 'book_ext_id' AND `COLUMN_TYPE` = 'varchar(64)' AND `IS_NULLABLE` = 'NO' AND `COLUMN_DEFAULT` IS NULL), 'SELECT 1', 'ALTER TABLE `mirror_highlights` MODIFY COLUMN `book_ext_id` varchar(64) NOT NULL');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
ALTER TABLE `mirror_highlights` MODIFY COLUMN `text` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_highlights` MODIFY COLUMN `pdf_anchor` longtext;--> statement-breakpoint
ALTER TABLE `mirror_highlights` MODIFY COLUMN `note` longtext;--> statement-breakpoint
ALTER TABLE `mirror_highlights` MODIFY COLUMN `ai_qa` longtext;--> statement-breakpoint
ALTER TABLE `mirror_highlights` MODIFY COLUMN `tags` longtext;--> statement-breakpoint
ALTER TABLE `mirror_highlights` MODIFY COLUMN `cloze` longtext;--> statement-breakpoint
ALTER TABLE `mirror_highlights` MODIFY COLUMN `review` longtext;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_mindmaps' AND `COLUMN_NAME` = 'book_ext_id' AND `COLUMN_TYPE` = 'varchar(64)' AND `IS_NULLABLE` = 'NO' AND `COLUMN_DEFAULT` IS NULL), 'SELECT 1', 'ALTER TABLE `mirror_mindmaps` MODIFY COLUMN `book_ext_id` varchar(64) NOT NULL');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
ALTER TABLE `mirror_mindmaps` MODIFY COLUMN `root` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_notes` MODIFY COLUMN `content` longtext NOT NULL;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_translations' AND `COLUMN_NAME` = 'book_ext_id' AND `COLUMN_TYPE` = 'varchar(64)' AND `IS_NULLABLE` = 'NO' AND `COLUMN_DEFAULT` IS NULL), 'SELECT 1', 'ALTER TABLE `mirror_translations` MODIFY COLUMN `book_ext_id` varchar(64) NOT NULL');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
ALTER TABLE `mirror_translations` MODIFY COLUMN `text` longtext NOT NULL;--> statement-breakpoint

-- Preserve only non-null invalid note references. NULL is the valid unlinked state.
CREATE TABLE IF NOT EXISTS `_migration_0008_invalid_note_highlights` LIKE `mirror_highlights`;--> statement-breakpoint
DELETE FROM `_migration_0008_invalid_note_highlights` WHERE `note_ext_id` IS NULL;--> statement-breakpoint
INSERT IGNORE INTO `_migration_0008_invalid_note_highlights` SELECT h.* FROM `mirror_highlights` h LEFT JOIN `mirror_notes` n ON n.`ext_id` = h.`note_ext_id` WHERE h.`note_ext_id` IS NOT NULL AND (h.`note_ext_id` = '' OR n.`ext_id` IS NULL);--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_highlights' AND `COLUMN_NAME` = 'note_ext_id' AND `COLUMN_TYPE` = 'varchar(64)' AND `IS_NULLABLE` = 'YES' AND `COLUMN_DEFAULT` IS NULL), 'SELECT 1', 'ALTER TABLE `mirror_highlights` MODIFY COLUMN `note_ext_id` varchar(64)');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
UPDATE `mirror_highlights` h LEFT JOIN `mirror_notes` n ON n.`ext_id` = h.`note_ext_id` SET h.`note_ext_id` = NULL WHERE h.`note_ext_id` IS NOT NULL AND (h.`note_ext_id` = '' OR n.`ext_id` IS NULL);--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_notes' AND `COLUMN_NAME` = 'client_updated_at'), 'SELECT 1', 'ALTER TABLE `mirror_notes` ADD `client_updated_at` bigint DEFAULT 0 NOT NULL');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_migration_0008_orphan_book_digests` LIKE `book_digests`;--> statement-breakpoint
INSERT IGNORE INTO `_migration_0008_orphan_book_digests` SELECT d.* FROM `book_digests` d LEFT JOIN `mirror_books` b ON b.`content_hash` = d.`content_hash` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
DELETE d FROM `book_digests` d LEFT JOIN `mirror_books` b ON b.`content_hash` = d.`content_hash` WHERE b.`ext_id` IS NULL;--> statement-breakpoint

-- Re-add every expected FK only when the named constraint is absent.
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`TABLE_CONSTRAINTS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_associations' AND `CONSTRAINT_NAME` = 'mirror_associations_source_book_ext_id_mirror_books_ext_id_fk' AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'), 'SELECT 1', 'ALTER TABLE `mirror_associations` ADD CONSTRAINT `mirror_associations_source_book_ext_id_mirror_books_ext_id_fk` FOREIGN KEY (`source_book_ext_id`) REFERENCES `mirror_books`(`ext_id`) ON DELETE cascade ON UPDATE cascade');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`TABLE_CONSTRAINTS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_associations' AND `CONSTRAINT_NAME` = 'mirror_associations_target_book_ext_id_mirror_books_ext_id_fk' AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'), 'SELECT 1', 'ALTER TABLE `mirror_associations` ADD CONSTRAINT `mirror_associations_target_book_ext_id_mirror_books_ext_id_fk` FOREIGN KEY (`target_book_ext_id`) REFERENCES `mirror_books`(`ext_id`) ON DELETE cascade ON UPDATE cascade');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`TABLE_CONSTRAINTS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_highlights' AND `CONSTRAINT_NAME` = 'mirror_highlights_book_ext_id_mirror_books_ext_id_fk' AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'), 'SELECT 1', 'ALTER TABLE `mirror_highlights` ADD CONSTRAINT `mirror_highlights_book_ext_id_mirror_books_ext_id_fk` FOREIGN KEY (`book_ext_id`) REFERENCES `mirror_books`(`ext_id`) ON DELETE cascade ON UPDATE cascade');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`TABLE_CONSTRAINTS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_mindmaps' AND `CONSTRAINT_NAME` = 'mirror_mindmaps_book_ext_id_mirror_books_ext_id_fk' AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'), 'SELECT 1', 'ALTER TABLE `mirror_mindmaps` ADD CONSTRAINT `mirror_mindmaps_book_ext_id_mirror_books_ext_id_fk` FOREIGN KEY (`book_ext_id`) REFERENCES `mirror_books`(`ext_id`) ON DELETE cascade ON UPDATE cascade');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`TABLE_CONSTRAINTS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_translations' AND `CONSTRAINT_NAME` = 'mirror_translations_book_ext_id_mirror_books_ext_id_fk' AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'), 'SELECT 1', 'ALTER TABLE `mirror_translations` ADD CONSTRAINT `mirror_translations_book_ext_id_mirror_books_ext_id_fk` FOREIGN KEY (`book_ext_id`) REFERENCES `mirror_books`(`ext_id`) ON DELETE cascade ON UPDATE cascade');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`TABLE_CONSTRAINTS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_highlights' AND `CONSTRAINT_NAME` = 'mirror_highlights_note_ext_id_mirror_notes_ext_id_fk' AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'), 'SELECT 1', 'ALTER TABLE `mirror_highlights` ADD CONSTRAINT `mirror_highlights_note_ext_id_mirror_notes_ext_id_fk` FOREIGN KEY (`note_ext_id`) REFERENCES `mirror_notes`(`ext_id`) ON DELETE set null ON UPDATE cascade');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
