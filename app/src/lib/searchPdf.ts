import type { Book } from "@/types";
import type { PdfSearchPage } from "./search";
import { getFile } from "./db";
import { openPdfDocument } from "./pdfjs";

/** Stream one page at a time and release the PDF worker on cancel or failure. */
export async function* searchPdfPages(
  book: Book,
  signal?: AbortSignal
): AsyncGenerator<PdfSearchPage> {
  signal?.throwIfAborted();
  const file = await getFile(book.id);
  if (!file) throw new Error("原始 PDF 文件尚未缓存，请重新导入后重试");
  const data =
    file.data instanceof Blob
      ? await file.data.arrayBuffer()
      : file.data.slice(0);
  signal?.throwIfAborted();
  const task = openPdfDocument(data);
  const abort = () => {
    void task.destroy().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const doc = await task.promise;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map(item =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""
          )
          .join("");
        yield { page: pageNumber, text };
      } finally {
        page.cleanup();
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await task.destroy();
  }
}
