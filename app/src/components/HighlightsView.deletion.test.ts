// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Library } from "@/hooks/useLibrary";
import type { Highlight } from "@/types";
import { HighlightsView } from "./HighlightsView";

const answered: Highlight = {
  id: "qa-1",
  bookId: "book-1",
  chapterId: "chapter-1",
  chapterTitle: "第一章",
  text: "保留的原句",
  style: { kind: "none", color: "orange" },
  aiQa: [{ q: "问题", a: "回答", ts: 1 }],
  createdAt: 1,
};

it("hides empty old AI anchors and reports a failed card deletion", async () => {
  const removeHighlight = vi.fn().mockRejectedValue(new Error("offline"));
  const lib = {
    highlights: [
      { ...answered, id: "old", text: "已删除问答", aiQa: [] },
      answered,
    ],
    books: [{ id: "book-1", title: "测试书" }],
    removeHighlight,
  } as unknown as Library;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(HighlightsView, { lib })));
  expect(host.textContent).toContain("保留的原句");
  expect(host.textContent).not.toContain("已删除问答");
  const remove = Array.from(host.querySelectorAll("button")).find(
    button => button.textContent === "删除"
  );
  await act(async () => remove?.click());
  expect(removeHighlight).toHaveBeenCalledWith("qa-1");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "删除失败"
  );
  expect(host.textContent).toContain("保留的原句");
  await act(async () => root.unmount());
  host.remove();
});
