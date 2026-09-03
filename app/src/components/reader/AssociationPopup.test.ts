import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Association, Book, PassageAnchor } from "@/types";
import { AssociationPopup } from "./AssociationPopup";

const source: PassageAnchor = {
  kind: "text",
  bookId: "book-a",
  chapterId: "chapter-a",
  chapterTitle: "第一章",
  text: "观点 A。",
  paraIndex: 0,
  start: 0,
  end: 5,
};
const target: PassageAnchor = {
  kind: "text",
  bookId: "book-b",
  chapterId: "chapter-b",
  chapterTitle: "第二章",
  text: "观点 B。",
  paraIndex: 1,
  start: 3,
  end: 8,
};
const association: Association = {
  id: "relation-1",
  source,
  target,
  direction: "bidirectional",
  label: "相似观点",
  pairKey: "pair-1",
  createdAt: 1,
  updatedAt: 2,
};
const books = [
  {
    id: "book-a",
    title: "A 书",
    author: "",
    format: "builtin",
    coverTone: 0,
    chapters: [],
    createdAt: 1,
    progress: { chapterId: "", ratio: 0 },
  },
  {
    id: "book-b",
    title: "B 书",
    author: "",
    format: "builtin",
    coverTone: 0,
    chapters: [],
    createdAt: 1,
    progress: { chapterId: "", ratio: 0 },
  },
] satisfies Book[];

describe("AssociationPopup", () => {
  it("previews the peer with direction, label, jump, add and delete actions", () => {
    const html = renderToStaticMarkup(
      createElement(AssociationPopup, {
        top: 10,
        left: 20,
        current: source,
        associations: [association],
        books,
        onNavigate: vi.fn(),
        onDelete: vi.fn(),
        onAdd: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain('aria-label="管理文段关联"');
    expect(html).toContain("关联 · 1");
    expect(html).toContain("双向 · B 书 · 第二章");
    expect(html).toContain("观点 B。");
    expect(html).toContain("相似观点");
    expect(html).toContain("跳转");
    expect(html).toContain("删除关联");
    expect(html).toContain("新建关联");
  });
});
