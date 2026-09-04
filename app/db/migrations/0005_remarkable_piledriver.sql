CREATE TABLE IF NOT EXISTS `app_users` (
	`id` int NOT NULL,
	`username_encrypted` varchar(512) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`credential_version` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `app_users_id` PRIMARY KEY(`id`)
);
