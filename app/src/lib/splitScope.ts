import type { Book, StudySet } from "@/types";

/** Resolve the books visible to reference panes without consulting folderId. */
export function getSplitBooks(
  books: Book[],
  currentBook: Book,
  studySet?: StudySet
): Book[] {
  if (!studySet) return books;
  const selected = books.filter(book => studySet.bookIds.includes(book.id));
  return selected.some(book => book.id === currentBook.id)
    ? selected
    : [currentBook, ...selected];
}
