import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Book, Highlight, PassageAnchor } from "@/types";
import { AssociationPicker } from "./AssociationPicker";
import { PdfSelectionToolbar } from "./PdfSelectionToolbar";
import { SelectionToolbar } from "./SelectionToolbar";

const book: Book = {
  id: "book-a",
  title: "关联测试书",
  author: "测试作者",
  format: "builtin",
  coverTone: 1,
  chapters: [
    {
      id: "chapter-a",
      title: "第一章",
      paragraphs: ["相同句。另一个句子。", "相同句。"],
    },
  ],
  createdAt: 1,
  progress: { chapterId: "chapter-a", ratio: 0 },
};

const source: PassageAnchor = {
  kind: "text",
  bookId: book.id,
  chapterId: "chapter-a",
  chapterTitle: "第一章",
  text: "相同句。",
  paraIndex: 0,
  start: 0,
  end: 4,
};

describe("AssociationPicker", () => {
  it("renders a distinct association flow with precise non-self targets", () => {
    const html = renderToStaticMarkup(
      createElement(AssociationPicker, {
        books: [book],
        source,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="选择关联目标"');
    expect(html).toContain("建立内容关联");
    expect(html).toContain("不会将内容引用到笔记");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("单向 A→B");
    expect(html).toContain("关系说明");
    expect(html).toContain('aria-label="关联目标书籍"');
    expect(html).toContain('aria-label="关联目标章节"');
    expect(html).toContain('aria-label="搜索关联目标句子"');
    expect(html).toContain('aria-label="选择关联目标：另一个句子。"');

    // The exact source range is excluded, while identical text at another
    // paragraph remains a valid target because identity uses its offsets.
    expect(html.match(/aria-label="选择关联目标：相同句。"/g)).toHaveLength(1);
    expect(html).not.toContain("新建书摘笔记");
    expect(html).not.toContain("引用当前选中文段");
  });

  it("handles an empty library without hiding the fixed source", () => {
    const html = renderToStaticMarkup(
      createElement(AssociationPicker, {
        books: [],
        source,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain(source.text);
    expect(html).toContain("书架中还没有可关联的书籍");
  });

  it("offers precise existing PDF excerpts as original-layout targets", () => {
    const pdfBook: Book = {
      ...book,
      id: "pdf-book",
      title: "PDF 研究资料",
      format: "pdf",
      readerMode: "original",
      chapters: [{ id: "pdf-chapter", title: "全文", paragraphs: [] }],
      progress: { chapterId: "pdf-chapter", ratio: 0 },
    };
    const pdfSource: PassageAnchor = {
      kind: "pdf",
      bookId: pdfBook.id,
      chapterId: "pdf-chapter",
      chapterTitle: "全文 · 第 1 页",
      text: "PDF 起点",
      pdfAnchor: {
        page: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
      },
    };
    const targetHighlight: Highlight = {
      id: "pdf-highlight",
      bookId: pdfBook.id,
      chapterId: "pdf-chapter",
      chapterTitle: "全文 · 第 2 页",
      text: "PDF 目标句",
      pdfAnchor: {
        page: 2,
        rects: [{ x: 0.2, y: 0.3, width: 0.3, height: 0.04 }],
      },
      createdAt: 1,
    };
    const html = renderToStaticMarkup(
      createElement(AssociationPicker, {
        books: [pdfBook],
        highlights: [targetHighlight],
        source: pdfSource,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain('aria-label="选择关联目标：PDF 目标句"');
    expect(html).toContain("原版 PDF · 第 2 页");
    expect(html).toContain("已有精确书摘作为目标");
  });

  it("exposes a compact association action in text and PDF selections", () => {
    const callback = vi.fn();
    const textToolbar = renderToStaticMarkup(
      createElement(SelectionToolbar, {
        top: 0,
        left: 0,
        onHighlight: callback,
        onComment: callback,
        notes: [],
        sourceText: "选中的文本",
        onCite: callback,
        onAssociate: callback,
        onTranslate: callback,
        onAddToOutline: callback,
        onAskAi: callback,
        onSearch: callback,
        onClose: callback,
      })
    );
    const pdfToolbar = renderToStaticMarkup(
      createElement(PdfSelectionToolbar, {
        top: 0,
        left: 0,
        onHighlight: callback,
        onComment: callback,
        notes: [],
        sourceText: "PDF 选中文本",
        onCite: callback,
        onAssociate: callback,
        onCopy: callback,
        onClose: callback,
      })
    );

    for (const html of [textToolbar, pdfToolbar]) {
      expect(html).toContain('aria-label="关联"');
      expect(html).toContain("grid-cols-3");
      expect(html).toContain("max-w-0");
      expect(html).toContain("group-hover:max-w-20");
    }
  });
});
