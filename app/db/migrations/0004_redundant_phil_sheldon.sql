-- A no-journal database may already contain this table after `db:push`.
CREATE TABLE IF NOT EXISTS `mirror_event_receipts` (
	`delivery_id` varchar(64) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mirror_event_receipts_delivery_id` PRIMARY KEY(`delivery_id`)
);
--> statement-breakpoint
SET @shufang_migration_sql = IF(
	EXISTS(
		SELECT 1 FROM `information_schema`.`STATISTICS`
		WHERE `TABLE_SCHEMA` = DATABASE()
			AND `TABLE_NAME` = 'mirror_event_receipts'
			AND `INDEX_NAME` = 'idx_mirror_event_receipts_created'
	),
	'SELECT 1',
	'CREATE INDEX `idx_mirror_event_receipts_created` ON `mirror_event_receipts` (`created_at`)'
);--> statement-breakpoint
PREPARE shufang_migration_stmt FROM @shufang_migration_sql;--> statement-breakpoint
EXECUTE shufang_migration_stmt;--> statement-breakpoint
DEALLOCATE PREPARE shufang_migration_stmt;
