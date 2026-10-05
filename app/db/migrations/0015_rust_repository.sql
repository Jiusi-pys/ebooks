CREATE TABLE IF NOT EXISTS `rust_changes` (
	`seq` bigint unsigned AUTO_INCREMENT NOT NULL,
	`workspace` varchar(128) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`entity_id` varchar(128) NOT NULL,
	`revision` bigint unsigned NOT NULL,
	`deleted` boolean NOT NULL,
	`snapshot` longtext,
	CONSTRAINT `rust_changes_seq` PRIMARY KEY(`seq`),
	KEY `rust_changes_workspace` (`workspace`,`seq`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rust_entity_revisions` (
	`workspace` varchar(128) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`entity_id` varchar(128) NOT NULL,
	`revision` bigint unsigned NOT NULL,
	CONSTRAINT `rust_entity_revisions_workspace_kind_entity_id_pk` PRIMARY KEY(`workspace`,`kind`,`entity_id`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rust_local_values` (
	`workspace` varchar(128) NOT NULL,
	`local_key` varchar(256) NOT NULL,
	`revision` bigint unsigned NOT NULL,
	`value_json` longtext NOT NULL,
	CONSTRAINT `rust_local_values_workspace_local_key_pk` PRIMARY KEY(`workspace`,`local_key`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
