ALTER TABLE `book_digests` MODIFY COLUMN `overview` longtext;--> statement-breakpoint
SET @shufang_migration_sql = IF((SELECT `IS_NULLABLE` = 'YES' AND `COLUMN_DEFAULT` IS NULL FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_highlights' AND `COLUMN_NAME` = 'note_ext_id'), 'SELECT 1', 'ALTER TABLE `mirror_highlights` MODIFY COLUMN `note_ext_id` varchar(64)');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_migration_0008_invalid_note_highlights` LIKE `mirror_highlights`;--> statement-breakpoint
INSERT IGNORE INTO `_migration_0008_invalid_note_highlights` SELECT h.* FROM `mirror_highlights` h LEFT JOIN `mirror_notes` n ON n.`ext_id` = h.`note_ext_id` WHERE h.`note_ext_id` IS NOT NULL AND (h.`note_ext_id` = '' OR n.`ext_id` IS NULL);--> statement-breakpoint
UPDATE `mirror_highlights` h LEFT JOIN `mirror_notes` n ON n.`ext_id` = h.`note_ext_id` SET h.`note_ext_id` = NULL WHERE h.`note_ext_id` IS NOT NULL AND (h.`note_ext_id` = '' OR n.`ext_id` IS NULL);--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_notes' AND `COLUMN_NAME` = 'client_updated_at'), 'SELECT 1', 'ALTER TABLE `mirror_notes` ADD `client_updated_at` bigint DEFAULT 0 NOT NULL');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_migration_0008_orphan_book_digests` LIKE `book_digests`;--> statement-breakpoint
INSERT IGNORE INTO `_migration_0008_orphan_book_digests` SELECT d.* FROM `book_digests` d LEFT JOIN `mirror_books` b ON b.`content_hash` = d.`content_hash` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
DELETE d FROM `book_digests` d LEFT JOIN `mirror_books` b ON b.`content_hash` = d.`content_hash` WHERE b.`ext_id` IS NULL;--> statement-breakpoint
SET @shufang_migration_sql = IF(EXISTS(SELECT 1 FROM `information_schema`.`TABLE_CONSTRAINTS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_highlights' AND `CONSTRAINT_NAME` = 'mirror_highlights_note_ext_id_mirror_notes_ext_id_fk' AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'), 'SELECT 1', 'ALTER TABLE `mirror_highlights` ADD CONSTRAINT `mirror_highlights_note_ext_id_mirror_notes_ext_id_fk` FOREIGN KEY (`note_ext_id`) REFERENCES `mirror_notes`(`ext_id`) ON DELETE set null ON UPDATE cascade');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
