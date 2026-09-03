import type { ShufangEvent } from "./webhooks";

const BOOK_METADATA_FIELDS = [
  "extId",
  "title",
  "author",
  "format",
  "folder",
  "contentHash",
] as const;

/**
 * Build the event snapshot that may leave the server through a WebHook.
 *
 * Imported chapter text is needed by the server-side mirror, but it must not be
 * copied to every WebHook subscriber. Use an allow-list here so future fields
 * added to the browser payload do not accidentally become outbound data.
 */
export function sanitizeEventForWebhook(event: ShufangEvent): ShufangEvent {
  if (event.type !== "book.imported") return event;

  const safeData: Record<string, unknown> = {};
  for (const field of BOOK_METADATA_FIELDS) {
    const value = event.data[field];
    if (typeof value === "string") safeData[field] = value;
  }

  const chapters = event.data.chapters;
  const reportedCount = event.data.chapterCount;
  safeData.chapterCount = Array.isArray(chapters)
    ? chapters.length
    : typeof reportedCount === "number" &&
        Number.isFinite(reportedCount) &&
        reportedCount >= 0
      ? Math.floor(reportedCount)
      : 0;

  return { ...event, data: safeData };
}
