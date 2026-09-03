export type PdfViewerFailurePhase = "load" | "render";

const CANCELLATION_ERROR_NAMES = new Set([
  "AbortError",
  "AbortException",
  "RenderingCancelledException",
]);

/** PDF.js uses different cancellation errors for document, canvas and text tasks. */
export function isPdfViewerCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as { name?: unknown };
  if (
    typeof candidate.name === "string" &&
    CANCELLATION_ERROR_NAMES.has(candidate.name)
  ) {
    return true;
  }

  return false;
}

/** Return null for expected task cancellation; otherwise build a user-visible error. */
export function pdfViewerFailureMessage(
  error: unknown,
  phase: PdfViewerFailurePhase,
  page?: number
): string | null {
  // Document-load cleanup is already fenced by the effect's `cancelled`
  // flag. An AbortError while that effect is still active is an IndexedDB or
  // PDF worker failure and must remain visible. Render-task cancellation can
  // race the next effect before its sequence number advances, so filter it.
  if (phase === "render" && isPdfViewerCancellation(error)) return null;

  const detail =
    error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 240)
      : "未知错误";
  if (phase === "render") {
    const location =
      Number.isInteger(page) && (page ?? 0) > 0 ? `第 ${page} 页` : "PDF 页面";
    return `${location}渲染失败：${detail}`;
  }
  return `PDF 文件加载失败：${detail}`;
}
