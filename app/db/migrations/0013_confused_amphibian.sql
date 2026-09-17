CREATE TABLE `library_source_chunks` (
	`book_ext_id` varchar(64) NOT NULL,
	`upload_id` varchar(64) NOT NULL,
	`chunk_index` int NOT NULL,
	`payload` longtext NOT NULL,
	CONSTRAINT `library_source_chunks_book_ext_id_upload_id_chunk_index_pk` PRIMARY KEY(`book_ext_id`,`upload_id`,`chunk_index`)
);
--> statement-breakpoint
ALTER TABLE `mirror_books` ADD `reader_data` longtext;--> statement-breakpoint
ALTER TABLE `mirror_books` ADD `source_manifest` text;--> statement-breakpoint
ALTER TABLE `library_source_chunks` ADD CONSTRAINT `library_source_chunks_book_ext_id_mirror_books_ext_id_fk` FOREIGN KEY (`book_ext_id`) REFERENCES `mirror_books`(`ext_id`) ON DELETE cascade ON UPDATE no action;