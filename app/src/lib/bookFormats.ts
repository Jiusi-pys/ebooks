import type { BookFormat } from "@/types";

export type ImportBookFormat = Exclude<BookFormat, "builtin">;

export const BOOK_FILE_ACCEPT = ".pdf,.epub,.mobi,.azw,.azw3,.fb2,.txt";

export const SUPPORTED_FORMAT_LABEL =
  "PDF / EPUB / MOBI / AZW / AZW3 / FB2 / TXT";

const FORMAT_BY_EXTENSION: Record<string, ImportBookFormat> = {
  pdf: "pdf",
  epub: "epub",
  mobi: "mobi",
  azw: "mobi",
  azw3: "azw3",
  fb2: "fb2",
  txt: "txt",
};

export function detectBookFormat(name: string): ImportBookFormat | null {
  const extension = name
    .trim()
    .toLowerCase()
    .match(/\.([^.\\/]+)$/)?.[1];
  return extension ? (FORMAT_BY_EXTENSION[extension] ?? null) : null;
}

export function isPdfFile(file: Pick<File, "name">): boolean {
  return detectBookFormat(file.name) === "pdf";
}

/** Split an import batch because only PDFs require a reader-mode choice. */
export function splitImportFiles(files: File[]): {
  pdfs: File[];
  others: File[];
} {
  const pdfs: File[] = [];
  const others: File[] = [];
  for (const file of files) {
    (isPdfFile(file) ? pdfs : others).push(file);
  }
  return { pdfs, others };
}
