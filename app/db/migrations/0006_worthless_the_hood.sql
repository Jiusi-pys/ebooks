SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_books'
			AND `COLUMN_NAME` = 'metadata'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_books` ADD `metadata` text'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
