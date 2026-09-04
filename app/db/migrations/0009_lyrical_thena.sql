CREATE TABLE IF NOT EXISTS `mirror_note_tombstones` (
	`ext_id` varchar(64) NOT NULL,
	`deleted_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mirror_note_tombstones_ext_id` PRIMARY KEY(`ext_id`)
);
