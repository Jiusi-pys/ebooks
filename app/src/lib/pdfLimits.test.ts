import { describe, expect, it } from "vitest";

import {
  assertPdfFileSize,
  consumePdfTextBudget,
  MAX_PDF_FILE_BYTES,
  MAX_PDF_REFLOW_PAGES,
  MAX_PDF_TEXT_ITEMS_PER_PAGE,
  supportsCompletePdfReflow,
  type PdfTextBudget,
} from "./pdfLimits";

describe("PDF import resource limits", () => {
  it("does not create a silently truncated reflow copy", () => {
    expect(supportsCompletePdfReflow(MAX_PDF_REFLOW_PAGES)).toBe(true);
    expect(supportsCompletePdfReflow(MAX_PDF_REFLOW_PAGES + 1)).toBe(false);
  });

  it("rejects empty and oversized files before reading their bytes", () => {
    expect(() => assertPdfFileSize(0)).toThrow("PDF 文件为空");
    expect(() => assertPdfFileSize(MAX_PDF_FILE_BYTES + 1)).toThrow("128 MB");
    expect(() => assertPdfFileSize(MAX_PDF_FILE_BYTES)).not.toThrow();
  });

  it("rejects a page before copying an excessive text-item array", () => {
    const budget: PdfTextBudget = { characters: 0, items: 0 };
    const firstChunk = new Array(MAX_PDF_TEXT_ITEMS_PER_PAGE).fill({
      str: "x",
    });
    const pageItems = consumePdfTextBudget(budget, firstChunk);
    expect(() =>
      consumePdfTextBudget(budget, [{ str: "x" }], pageItems)
    ).toThrow("单页");
  });

  it("tracks the cumulative extracted text budget", () => {
    const budget: PdfTextBudget = { characters: 11_999_999, items: 0 };
    expect(() => consumePdfTextBudget(budget, [{ str: "ab" }])).toThrow(
      "1200 万字符"
    );
  });
});
