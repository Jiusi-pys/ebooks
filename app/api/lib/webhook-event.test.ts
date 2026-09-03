import { describe, expect, it } from "vitest";
import { sanitizeEventForWebhook } from "./webhook-event";
import { EVENT_TYPES } from "./webhooks";

describe("sanitizeEventForWebhook", () => {
  it("advertises passage-association lifecycle events", () => {
    expect(EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "association.created",
        "association.updated",
        "association.deleted",
      ])
    );
  });

  it("keeps imported-book metadata while removing chapter text", () => {
    const event = {
      type: "book.imported",
      source: "reader",
      data: {
        extId: "book-1",
        title: "示例书",
        author: "作者",
        format: "epub",
        folder: "技术",
        contentHash: "abc123",
        chapters: [
          { id: "chapter-1", title: "第一章", paragraphs: ["私密正文"] },
          { id: "chapter-2", title: "第二章", paragraphs: ["更多正文"] },
        ],
        content: "不应透传的附加正文",
      },
    };

    const safe = sanitizeEventForWebhook(event);

    expect(safe).toEqual({
      type: "book.imported",
      source: "reader",
      data: {
        extId: "book-1",
        title: "示例书",
        author: "作者",
        format: "epub",
        folder: "技术",
        contentHash: "abc123",
        chapterCount: 2,
      },
    });
    expect(event.data.chapters[0].paragraphs).toEqual(["私密正文"]);
  });

  it("preserves a server-reported chapter count without chapter bodies", () => {
    const safe = sanitizeEventForWebhook({
      type: "book.imported",
      source: "api",
      data: { extId: "book-2", title: "API 书籍", chapterCount: 3 },
    });

    expect(safe.data).toEqual({
      extId: "book-2",
      title: "API 书籍",
      chapterCount: 3,
    });
  });

  it("does not alter unrelated events", () => {
    const event = {
      type: "highlight.created",
      data: { extId: "highlight-1", text: "划线正文" },
    };

    expect(sanitizeEventForWebhook(event)).toBe(event);
  });
});
