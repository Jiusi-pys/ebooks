import { describe, expect, it } from "vitest";
import type { Highlight } from "@/types";
import { isReaderHighlightInteractive } from "./highlightVisibility";

const anchor: Highlight = {
  id: "old-ai-anchor",
  bookId: "book",
  chapterId: "chapter",
  chapterTitle: "第一章",
  text: "曾经问过 AI 的句子",
  paraIndex: 0,
  start: 0,
  end: 10,
  style: { kind: "none", color: "orange" },
  createdAt: 1,
};

describe("isReaderHighlightInteractive", () => {
  it("ignores an AI-only anchor after its question has been removed", () => {
    expect(isReaderHighlightInteractive(anchor)).toBe(false);
    expect(isReaderHighlightInteractive({ ...anchor, aiQa: [] })).toBe(false);
  });

  it("keeps anchors with an answer or other reader data", () => {
    expect(
      isReaderHighlightInteractive({
        ...anchor,
        aiQa: [{ q: "为什么", a: "因为", ts: 1 }],
      })
    ).toBe(true);
    expect(isReaderHighlightInteractive({ ...anchor, note: "我的批注" })).toBe(
      true
    );
    expect(isReaderHighlightInteractive({ ...anchor, noteId: "note" })).toBe(
      true
    );
    expect(
      isReaderHighlightInteractive({
        ...anchor,
        style: { kind: "underline", color: "orange" },
      })
    ).toBe(true);
  });
});
