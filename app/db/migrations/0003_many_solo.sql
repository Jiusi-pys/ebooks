-- `db:push` can create this table before Drizzle's migration journal exists.
CREATE TABLE IF NOT EXISTS `mirror_book_upload_chunks` (
	`book_ext_id` varchar(64) NOT NULL,
	`upload_id` varchar(64) NOT NULL,
	`chunk_index` int NOT NULL,
	`chunk_count` int NOT NULL,
	`encoded_bytes` int NOT NULL,
	`title` varchar(255) NOT NULL DEFAULT '',
	`author` varchar(255) NOT NULL DEFAULT '',
	`format` varchar(16) NOT NULL DEFAULT 'unknown',
	`folder` varchar(255) NOT NULL DEFAULT '',
	`content_hash` varchar(64) NOT NULL DEFAULT '',
	`chapter_count` int NOT NULL DEFAULT 0,
	`payload` longtext NOT NULL,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pk_mirror_book_upload_chunks` PRIMARY KEY(`book_ext_id`,`upload_id`,`chunk_index`)
);
--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`STATISTICS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_book_upload_chunks'
			AND `INDEX_NAME` = 'idx_mirror_book_uploads_updated'
	),
	'SELECT 1',
	'CREATE INDEX `idx_mirror_book_uploads_updated` ON `mirror_book_upload_chunks` (`updated_at`)'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
