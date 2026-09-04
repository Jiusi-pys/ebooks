CREATE TABLE IF NOT EXISTS `mirror_book_tombstones` (
	`ext_id` varchar(64) NOT NULL,
	`deleted_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mirror_book_tombstones_ext_id` PRIMARY KEY(`ext_id`)
);
--> statement-breakpoint
ALTER TABLE `book_digests` MODIFY COLUMN `structure` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_associations` MODIFY COLUMN `source_text` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_associations` MODIFY COLUMN `target_text` longtext NOT NULL;--> statement-breakpoint
SET @shufang_migration_sql = IF((SELECT `COLUMN_DEFAULT` IS NULL FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_highlights' AND `COLUMN_NAME` = 'book_ext_id'), 'SELECT 1', 'ALTER TABLE `mirror_highlights` MODIFY COLUMN `book_ext_id` varchar(64) NOT NULL');--> statement-breakpoint
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
SET @shufang_migration_sql = IF((SELECT `COLUMN_DEFAULT` IS NULL FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_mindmaps' AND `COLUMN_NAME` = 'book_ext_id'), 'SELECT 1', 'ALTER TABLE `mirror_mindmaps` MODIFY COLUMN `book_ext_id` varchar(64) NOT NULL');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
ALTER TABLE `mirror_mindmaps` MODIFY COLUMN `root` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_notes` MODIFY COLUMN `content` longtext NOT NULL;--> statement-breakpoint
SET @shufang_migration_sql = IF((SELECT `COLUMN_DEFAULT` IS NULL FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mirror_translations' AND `COLUMN_NAME` = 'book_ext_id'), 'SELECT 1', 'ALTER TABLE `mirror_translations` MODIFY COLUMN `book_ext_id` varchar(64) NOT NULL');--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
ALTER TABLE `mirror_translations` MODIFY COLUMN `text` longtext NOT NULL;--> statement-breakpoint
-- Preserve legacy orphan rows before enforcing referential integrity. These
-- quarantine tables make an interrupted or mistaken cleanup recoverable.
CREATE TABLE IF NOT EXISTS `_migration_0007_orphan_highlights` LIKE `mirror_highlights`;--> statement-breakpoint
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
DEALLOCATE PREPARE shufang_migration_stmt;
