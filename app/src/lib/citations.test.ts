import { describe, expect, it } from "vitest";
import {
  appendCitationBlock,
  citationBlock,
  citationDescriptorForHighlight,
  citationLevelOf,
  isCitationOnlyHighlight,
  removeCitationBlock,
  removeCitationBlocks,
  renameCitationBookTitle,
  renameCitationBookTitles,
  rewriteCitationBlock,
} from "./citations";

const citation = {
  bookTitle: "论语",
  chapterTitle: "为政第二",
  text: "学而不思则罔，\n思而不学则殆。",
};

describe("structured citations", () => {
  it("quotes every selected line and links the source book", () => {
    expect(citationBlock(citation)).toBe(
      "> 学而不思则罔，\n> 思而不学则殆。\n\n—— [[论语]] → 为政第二 → 具体内容"
    );
  });

  it("represents book and chapter citations without inventing content", () => {
    expect(citationBlock({ level: "book", bookTitle: "论语" })).toBe(
      "> 书籍引用：[[论语]]"
    );
    expect(
      citationBlock({
        level: "chapter",
        bookTitle: "论语",
        chapterTitle: "为政第二",
      })
    ).toBe("> 章节引用：[[论语]] → 为政第二");
  });

  it("appends a citation only once", () => {
    const once = appendCitationBlock("已有笔记", citation);
    expect(appendCitationBlock(once, citation)).toBe(once);
  });

  it("removes only the matching citation block", () => {
    const content = appendCitationBlock("前文\n\n后文", citation);
    expect(removeCitationBlock(content, citation)).toBe("前文\n\n后文");
  });

  it("leaves manually written content untouched when no block matches", () => {
    expect(removeCitationBlock("普通内容", citation)).toBe("普通内容");
    expect(
      removeCitationBlock("我手写的普通双链：[[论语]]，稍后再读。", citation)
    ).toBe("我手写的普通双链：[[论语]]，稍后再读。");
  });

  it("matches only a complete generated block", () => {
    const generated = citationBlock({ level: "book", bookTitle: "论语" });
    const handWritten = `${generated}，这是我的补充说明`;
    expect(
      removeCitationBlock(handWritten, {
        level: "book",
        bookTitle: "论语",
      })
    ).toBe(handWritten);
  });

  it("recognizes and removes citation blocks created before level metadata", () => {
    const legacy =
      "> 学而不思则罔，\n> 思而不学则殆。\n\n—— [[论语]] · 为政第二";
    expect(appendCitationBlock(legacy, citation)).toBe(legacy);
    expect(removeCitationBlock(`开头\n\n${legacy}\n`, citation)).toBe("开头");
  });

  it("removes all generated blocks for a deleted source book", () => {
    const bookCitation = { level: "book" as const, bookTitle: "论语" };
    const chapterCitation = {
      level: "chapter" as const,
      bookTitle: "论语",
      chapterTitle: "学而第一",
    };
    const content = [
      "我的 [[论语]] 阅读计划",
      citationBlock(bookCitation),
      citationBlock(chapterCitation),
      citationBlock(citation),
    ].join("\n\n");

    expect(
      removeCitationBlocks(content, [bookCitation, chapterCitation, citation])
    ).toBe("我的 [[论语]] 阅读计划");
  });

  it("migrates generated links on rename but preserves ordinary wiki-links", () => {
    const bookCitation = { level: "book" as const, bookTitle: "旧书名" };
    const chapterCitation = {
      level: "chapter" as const,
      bookTitle: "旧书名",
      chapterTitle: "第一章",
    };
    const contentCitation = {
      level: "content" as const,
      bookTitle: "旧书名",
      chapterTitle: "第一章",
      text: "一段原文",
    };
    const content = [
      "手写链接 [[旧书名]] 不应被改写。",
      citationBlock(bookCitation),
      citationBlock(chapterCitation),
      citationBlock(contentCitation),
    ].join("\n\n");

    const renamed = renameCitationBookTitles(
      content,
      [bookCitation, chapterCitation, contentCitation],
      "新书名"
    );
    expect(renamed).toContain("手写链接 [[旧书名]] 不应被改写。");
    expect(renamed).toContain("> 书籍引用：[[新书名]]");
    expect(renamed).toContain("> 章节引用：[[新书名]] → 第一章");
    expect(renamed).toContain("—— [[新书名]] → 第一章 → 具体内容");
    expect(
      removeCitationBlocks(renamed, [
        { ...bookCitation, bookTitle: "新书名" },
        { ...chapterCitation, bookTitle: "新书名" },
        { ...contentCitation, bookTitle: "新书名" },
      ])
    ).toBe("手写链接 [[旧书名]] 不应被改写。");
  });

  it("migrates legacy CRLF blocks and keeps them removable", () => {
    const descriptor = {
      bookTitle: "旧书名",
      chapterTitle: "第一章",
      text: "第一行\n第二行",
    };
    const legacy = "> 第一行\r\n> 第二行\r\n\r\n—— [[旧书名]] · 第一章";
    const content = `开头\r\n\r\n${legacy}\r\n\r\n手写 [[旧书名]]`;
    const renamed = renameCitationBookTitle(content, descriptor, "新书名");

    expect(renamed).toContain("—— [[新书名]] · 第一章");
    expect(renamed).toContain("手写 [[旧书名]]");
    expect(
      removeCitationBlock(renamed, { ...descriptor, bookTitle: "新书名" })
    ).toBe("开头\n\n手写 [[旧书名]]");
  });

  it("rewrites a changed descriptor and appends it when the old block is absent", () => {
    const next = {
      level: "chapter" as const,
      bookTitle: "孟子",
      chapterTitle: "梁惠王上",
    };
    const rewritten = rewriteCitationBlock(
      `手写 [[论语]]\n\n${citationBlock(citation)}`,
      citation,
      next
    );
    expect(rewritten).toContain("手写 [[论语]]");
    expect(rewritten).not.toContain("学而不思则罔");
    expect(rewritten).toContain("> 章节引用：[[孟子]] → 梁惠王上");

    const appended = rewriteCitationBlock("已有笔记", citation, next);
    expect(rewriteCitationBlock(appended, citation, next)).toBe(appended);
  });

  it("upgrades one legacy block to a stable marker without duplicating it", () => {
    const legacy = citationBlock(citation);
    const first = appendCitationBlock(legacy, {
      ...citation,
      highlightId: "highlight-1",
    });
    expect(first.match(/shufang-citation-id:/g)).toHaveLength(1);
    expect(first.match(/具体内容/g)).toHaveLength(1);

    const second = appendCitationBlock(first, {
      ...citation,
      highlightId: "highlight-2",
    });
    expect(second).toContain("shufang-citation-id:highlight%2D1");
    expect(second).toContain("shufang-citation-id:highlight%2D2");
    expect(second.match(/具体内容/g)).toHaveLength(2);
  });

  it("removes duplicate markers for one highlight but preserves its peer", () => {
    const first = { ...citation, highlightId: "highlight-1" };
    const second = { ...citation, highlightId: "highlight-2" };
    const content = [
      citationBlock(first),
      citationBlock(first),
      citationBlock(second),
    ].join("\n\n");
    const cleaned = removeCitationBlock(content, first);

    expect(cleaned).not.toContain("shufang-citation-id:highlight%2D1");
    expect(cleaned).toContain("shufang-citation-id:highlight%2D2");
  });

  it("distinguishes a citation-only anchor from an enriched highlight", () => {
    const base = {
      id: "citation-1",
      bookId: "book-1",
      chapterId: "chapter-1",
      chapterTitle: "第一章",
      text: "原文",
      style: { kind: "none" as const, color: "orange" },
      noteId: "note-1",
      createdAt: 1,
    };
    expect(isCitationOnlyHighlight(base)).toBe(true);
    expect(isCitationOnlyHighlight({ ...base, note: "我的批注" })).toBe(false);
    expect(citationLevelOf(base)).toBe("content");
    expect(
      citationDescriptorForHighlight(
        { ...base, citation: { level: "chapter", chapterId: "chapter-1" } },
        "论语"
      )
    ).toEqual({
      level: "chapter",
      highlightId: "citation-1",
      bookTitle: "论语",
      chapterTitle: "第一章",
      text: "原文",
    });
  });
});
