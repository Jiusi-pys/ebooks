import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Highlight } from "@/types";
import { HighlightPopup } from "./ReaderView";

vi.mock("./reader/PdfCanvasViewer", () => ({
  PdfCanvasViewer: () => null,
}));

const highlight: Highlight = {
  id: "highlight-1",
  bookId: "book-1",
  chapterId: "chapter-1",
  chapterTitle: "第一章",
  text: "一段已经标注的原文",
  style: { kind: "underline", color: "orange" },
  note: "已有批注",
  noteId: "note-1",
  review: {
    due: 1,
    reps: 0,
    lapses: 0,
    interval: 0,
    addedAt: 1,
  },
  createdAt: 1,
};

describe("HighlightPopup actions", () => {
  it("renders compact icon actions whose labels expand on hover or focus", () => {
    const callback = vi.fn();
    const html = renderToStaticMarkup(
      createElement(HighlightPopup, {
        h: highlight,
        top: 0,
        left: 0,
        notes: [],
        onEditNote: callback,
        onEditName: callback,
        onEditTags: callback,
        onEditCloze: callback,
        onToggleReview: callback,
        onAddToMindMap: callback,
        onAddToOutline: callback,
        associationCount: 0,
        onAssociate: callback,
        onCite: callback,
        onUnlinkCitation: callback,
        onAskAi: callback,
        onDelete: callback,
        onClose: callback,
      })
    );

    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="已有书摘的操作"');
    for (const label of [
      "改批注",
      "标签",
      "移出复习",
      "脑图",
      "目录",
      "关联",
      "取消引用",
      "问 AI",
      "删除",
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html.match(/max-w-0/g)).toHaveLength(9);
    expect(html.match(/group-hover:max-w-20/g)).toHaveLength(9);
    expect(html.match(/group-focus:max-w-20/g)).toHaveLength(9);
  });
});
