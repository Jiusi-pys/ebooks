const MEBIBYTE = 1024 * 1024;

export const MAX_PDF_FILE_BYTES = 128 * MEBIBYTE;
export const MAX_PDF_REFLOW_PAGES = 600;
export const MAX_PDF_TEXT_CHARACTERS = 12_000_000;
export const MAX_PDF_TEXT_ITEMS_PER_PAGE = 200_000;
export const MAX_PDF_TEXT_ITEMS = 1_000_000;

export interface PdfTextBudget {
  characters: number;
  items: number;
}

export function supportsCompletePdfReflow(pageCount: number): boolean {
  return pageCount > 0 && pageCount <= MAX_PDF_REFLOW_PAGES;
}

export function assertPdfFileSize(size: number): void {
  if (size <= 0) throw new Error("PDF 文件为空");
  if (size > MAX_PDF_FILE_BYTES) {
    throw new Error("PDF 文件不能超过 128 MB");
  }
}

/**
 * Stop before duplicating an unusually large PDF.js text-content response into
 * line and paragraph arrays. PDF.js performs stream decompression in its own
 * worker; this budget bounds the resulting main-thread data retained by us.
 */
export function consumePdfTextBudget(
  budget: PdfTextBudget,
  items: readonly { str?: string }[],
  previousPageItems = 0
): number {
  const pageItems = previousPageItems + items.length;
  if (pageItems > MAX_PDF_TEXT_ITEMS_PER_PAGE) {
    throw new Error("单页 PDF 文字对象过多，已停止导入");
  }

  budget.items += items.length;
  if (budget.items > MAX_PDF_TEXT_ITEMS) {
    throw new Error("PDF 文字对象超过 100 万个，已停止导入");
  }

  for (const item of items) budget.characters += item.str?.length ?? 0;
  if (budget.characters > MAX_PDF_TEXT_CHARACTERS) {
    throw new Error("PDF 正文超过 1200 万字符，已停止导入");
  }
  return pageItems;
}
