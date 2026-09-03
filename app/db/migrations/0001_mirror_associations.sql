-- A legacy database may already contain this table because it was managed with
-- `db:push` before the migration journal was introduced.
CREATE TABLE IF NOT EXISTS `mirror_associations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ext_id` varchar(64) NOT NULL,
	`source_kind` varchar(8) NOT NULL,
	`source_book_ext_id` varchar(64) NOT NULL,
	`source_chapter_id` varchar(64) NOT NULL,
	`source_chapter_title` varchar(255) DEFAULT '' NOT NULL,
	`source_text` text NOT NULL,
	`source_para_index` int,
	`source_start_offset` int,
	`source_end_offset` int,
	`source_pdf_anchor` longtext,
	`target_kind` varchar(8) NOT NULL,
	`target_book_ext_id` varchar(64) NOT NULL,
	`target_chapter_id` varchar(64) NOT NULL,
	`target_chapter_title` varchar(255) DEFAULT '' NOT NULL,
	`target_text` text NOT NULL,
	`target_para_index` int,
	`target_start_offset` int,
	`target_end_offset` int,
	`target_pdf_anchor` longtext,
	`direction` varchar(32) NOT NULL,
	`label` varchar(255),
	`pair_key` longtext NOT NULL,
	`pair_key_hash` varchar(64) NOT NULL,
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `mirror_associations_id` PRIMARY KEY(`id`),
	CONSTRAINT `mirror_associations_ext_id_unique` UNIQUE(`ext_id`),
	CONSTRAINT `mirror_associations_pair_key_hash_unique` UNIQUE(`pair_key_hash`)
);
--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`STATISTICS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_associations'
			AND `INDEX_NAME` = 'idx_mirror_assoc_source_book'
	),
	'SELECT 1',
	'CREATE INDEX `idx_mirror_assoc_source_book` ON `mirror_associations` (`source_book_ext_id`)'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`STATISTICS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_associations'
			AND `INDEX_NAME` = 'idx_mirror_assoc_target_book'
	),
	'SELECT 1',
	'CREATE INDEX `idx_mirror_assoc_target_book` ON `mirror_associations` (`target_book_ext_id`)'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
