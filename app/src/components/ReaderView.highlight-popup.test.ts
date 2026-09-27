// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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

async function mountPopup(h: Highlight = highlight) {
  const callback = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(HighlightPopup, {
        h,
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
    )
  );
  return { host, root, callback };
}

describe("HighlightPopup actions", () => {
  it("renders compact icon actions whose labels expand on hover or focus", async () => {
    const { host, root } = await mountPopup();
    const html = document.body.innerHTML;

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
    await act(async () => root.unmount());
    host.remove();
  });

  it("opens full answers locally, returns, and separately continues the same conversation", async () => {
    const answer = "详细解释".repeat(300) + "回答末尾";
    const { host, root, callback } = await mountPopup({
      ...highlight,
      aiQa: [{ q: "问题", a: answer, ts: 1 }],
    });
    const click = async (label: string) =>
      act(async () => {
        Array.from(document.querySelectorAll("button"))
          .find(b => b.textContent?.includes(label))!
          .click();
      });
    // The popup lives outside the paginated reader's clipping container.
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await click("查看完整回答");
    expect(
      document.querySelector('[aria-label="文段问答详情"]')?.textContent
    ).toContain(answer);
    expect(callback).not.toHaveBeenCalled();
    await click("返回文段");
    expect(document.querySelector('[aria-label="文段问答详情"]')).toBeNull();
    await click("到右侧继续追问");
    expect(callback).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    host.remove();
  });
});
