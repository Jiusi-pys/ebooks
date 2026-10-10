export function pdfScrollPosition(page: number, pages: number, top: number, size: number) {
  if (![page, pages, top, size].every(Number.isFinite) || pages < 1 || size <= 0) throw new Error("invalid_pdf_position");
  return { page: Math.min(pages, Math.max(1, page)), pages, fraction: Math.max(0, Math.min(1, -top / size)) };
}
export function pdfScrollOffset(start: number, size: number, fraction: number) {
  if (![start, size, fraction].every(Number.isFinite) || size <= 0) throw new Error("invalid_pdf_position");
  return start + size * Math.max(0, Math.min(1, fraction));
}
