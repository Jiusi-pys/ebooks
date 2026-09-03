import type { Book, Chapter } from "@/types";

export interface ReaderChapterState {
  chapter: Chapter | undefined;
  chapterIndex: number;
}

export type PdfReaderMode = "reflow" | "original";

/** Whether the extracted PDF contains any text that reflow mode can render. */
export function supportsPdfReflow(chapters: readonly Chapter[]): boolean {
  return chapters.some(chapter =>
    chapter.paragraphs.some(paragraph => paragraph.trim().length > 0)
  );
}

/** Scanned PDFs cannot use reflow; open them in original layout automatically. */
export function selectImportedPdfMode(
  requestedMode: PdfReaderMode,
  chapters: readonly Chapter[]
): PdfReaderMode {
  return supportsPdfReflow(chapters) ? requestedMode : "original";
}

/** Resolve the mode the reader can actually render, including legacy state. */
export function resolvePdfReaderMode(
  book: Pick<Book, "chapters" | "readerMode">
): PdfReaderMode {
  return selectImportedPdfMode(book.readerMode ?? "reflow", book.chapters);
}

/**
 * Resolve the active text chapter, or provide a stable logical anchor when an
 * original-layout PDF has no text layer (for example, a scanned document).
 */
export function resolveReaderChapter(
  book: Book,
  requestedChapterId?: string
): ReaderChapterState {
  const requestedIndex = requestedChapterId
    ? book.chapters.findIndex(chapter => chapter.id === requestedChapterId)
    : -1;
  const chapterIndex = Math.max(0, requestedIndex);
  const chapter = book.chapters[chapterIndex];
  if (chapter) return { chapter, chapterIndex };

  if (book.format === "pdf" && resolvePdfReaderMode(book) === "original") {
    return {
      chapter: {
        id: `pdf-original:${book.id}`,
        title: "原版 PDF",
        paragraphs: [],
      },
      chapterIndex: 0,
    };
  }

  return { chapter: undefined, chapterIndex: 0 };
}
