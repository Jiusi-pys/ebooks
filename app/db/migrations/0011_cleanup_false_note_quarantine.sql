-- Forward cleanup for installations that already recorded an earlier 0010.
-- Legacy 0008 copied valid, unlinked highlights into this quarantine because
-- the LEFT JOIN made n.ext_id NULL when h.note_ext_id was NULL. Empty and
-- non-empty invalid references are real quarantine records and must remain.
CREATE TABLE IF NOT EXISTS `_migration_0008_invalid_note_highlights` LIKE `mirror_highlights`;--> statement-breakpoint
DELETE FROM `_migration_0008_invalid_note_highlights` WHERE `note_ext_id` IS NULL;
