import { describe, expect, it } from "vitest";
import type { Book } from "@/types";
import {
  resolveReaderChapter,
  resolvePdfReaderMode,
  selectImportedPdfMode,
  supportsPdfReflow,
} from "./pdfReaderState";

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: "book-1",
    title: "扫描文档",
    author: "",
    format: "pdf",
    coverTone: 0,
    chapters: [],
    createdAt: 1,
    progress: { chapterId: "", ratio: 0 },
    ...overrides,
  };
}

describe("resolveReaderChapter", () => {
  it("provides a stable anchor for an original PDF without text chapters", () => {
    const book = makeBook({ readerMode: "original" });
    const first = resolveReaderChapter(book);
    const second = resolveReaderChapter(book);

    expect(first).toEqual({
      chapter: {
        id: "pdf-original:book-1",
        title: "原版 PDF",
        paragraphs: [],
      },
      chapterIndex: 0,
    });
    expect(second.chapter?.id).toBe(first.chapter?.id);
  });

  it("recovers a textless PDF persisted in reflow mode", () => {
    const book = makeBook({ readerMode: "reflow" });

    expect(resolvePdfReaderMode(book)).toBe("original");
    expect(resolveReaderChapter(book).chapter?.id).toBe("pdf-original:book-1");
  });

  it("does not invent a chapter for a non-PDF book", () => {
    expect(
      resolveReaderChapter(makeBook({ format: "epub", readerMode: "reflow" }))
        .chapter
    ).toBeUndefined();
  });

  it("uses the requested real chapter when text is available", () => {
    const chapters = [
      { id: "chapter-1", title: "一", paragraphs: ["正文一"] },
      { id: "chapter-2", title: "二", paragraphs: ["正文二"] },
    ];
    const result = resolveReaderChapter(
      makeBook({ readerMode: "original", chapters }),
      "chapter-2"
    );

    expect(result).toEqual({ chapter: chapters[1], chapterIndex: 1 });
  });
});

describe("selectImportedPdfMode", () => {
  it("switches a scanned PDF from the default reflow mode to original", () => {
    expect(selectImportedPdfMode("reflow", [])).toBe("original");
    expect(
      selectImportedPdfMode("reflow", [
        { id: "empty", title: "正文", paragraphs: ["   "] },
      ])
    ).toBe("original");
  });

  it("preserves the requested mode when reflow text exists", () => {
    const chapters = [
      { id: "text", title: "正文", paragraphs: ["可重排正文"] },
    ];
    expect(selectImportedPdfMode("reflow", chapters)).toBe("reflow");
    expect(selectImportedPdfMode("original", chapters)).toBe("original");
  });

  it("keeps a textless PDF in original mode when reflow is requested later", () => {
    const chapters = [
      { id: "scan-1", title: "第 1 页", paragraphs: ["", "\n\t"] },
    ];

    expect(supportsPdfReflow(chapters)).toBe(false);
    expect(selectImportedPdfMode("reflow", chapters)).toBe("original");
    expect(selectImportedPdfMode("original", chapters)).toBe("original");
  });

  it("allows reflow when any chapter contains visible text", () => {
    const chapters = [
      { id: "scan-1", title: "第 1 页", paragraphs: ["   "] },
      { id: "text-2", title: "第 2 页", paragraphs: ["可重排正文"] },
    ];

    expect(supportsPdfReflow(chapters)).toBe(true);
  });
});
