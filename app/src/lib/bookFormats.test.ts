import { describe, expect, it } from "vitest";
import { detectBookFormat, splitImportFiles } from "./bookFormats";

describe("detectBookFormat", () => {
  it.each([
    ["book.PDF", "pdf"],
    ["book.epub", "epub"],
    ["book.mobi", "mobi"],
    ["book.azw", "mobi"],
    ["book.AZW3", "azw3"],
    ["book.fb2", "fb2"],
    ["book.txt", "txt"],
  ])("maps %s to %s", (name, expected) => {
    expect(detectBookFormat(name)).toBe(expected);
  });

  it("rejects unknown or missing extensions", () => {
    expect(detectBookFormat("book.docx")).toBeNull();
    expect(detectBookFormat("book")).toBeNull();
    expect(detectBookFormat("book.epub.exe")).toBeNull();
  });

  it("separates PDFs from formats that import directly", () => {
    const pdf = { name: "scan.PDF" } as File;
    const epub = { name: "novel.epub" } as File;
    const mobi = { name: "reader.mobi" } as File;

    expect(splitImportFiles([epub, pdf, mobi])).toEqual({
      pdfs: [pdf],
      others: [epub, mobi],
    });
  });
});
