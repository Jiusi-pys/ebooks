-- Existing databases created mirror_books.chapters as TEXT. LONGTEXT is needed
-- for extracted book bodies that exceed MySQL's 64 KiB TEXT limit.
ALTER TABLE `mirror_books` MODIFY COLUMN `chapters` longtext NOT NULL;
