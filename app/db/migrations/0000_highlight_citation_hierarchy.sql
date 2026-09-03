ALTER TABLE `mirror_highlights` ADD `citation_level` varchar(16) DEFAULT 'content' NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_highlights` ADD `chapter_id` varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `mirror_highlights` ADD `para_index` int;--> statement-breakpoint
ALTER TABLE `mirror_highlights` ADD `start_offset` int;--> statement-breakpoint
ALTER TABLE `mirror_highlights` ADD `end_offset` int;--> statement-breakpoint
ALTER TABLE `mirror_highlights` ADD `pdf_anchor` text;--> statement-breakpoint
CREATE INDEX `idx_mirror_hl_chapter` ON `mirror_highlights` (`book_ext_id`,`chapter_id`);
