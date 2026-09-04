SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`COLUMNS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_highlights'
			AND `COLUMN_NAME` = 'name'
	),
	'SELECT 1',
	'ALTER TABLE `mirror_highlights` ADD `name` varchar(255) NULL'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
