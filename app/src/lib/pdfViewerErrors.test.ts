import { describe, expect, it } from "vitest";
import {
  isPdfViewerCancellation,
  pdfViewerFailureMessage,
} from "./pdfViewerErrors";

describe("PDF viewer errors", () => {
  it.each([
    { name: "AbortError" },
    { name: "AbortException" },
    { name: "RenderingCancelledException" },
  ])("does not report expected task cancellation: $name", error => {
    expect(isPdfViewerCancellation(error)).toBe(true);
    expect(pdfViewerFailureMessage(error, "render", 2)).toBeNull();
  });

  it("formats IndexedDB/document load failures for the visible error state", () => {
    expect(
      pdfViewerFailureMessage(
        new Error("IndexedDB transaction aborted"),
        "load"
      )
    ).toBe("PDF 文件加载失败：IndexedDB transaction aborted");
  });

  it("reports an active IndexedDB AbortError during document loading", () => {
    const error = new DOMException("The transaction was aborted", "AbortError");

    expect(pdfViewerFailureMessage(error, "load")).toBe(
      "PDF 文件加载失败：The transaction was aborted"
    );
  });

  it("includes the failed page for canvas or text-layer failures", () => {
    expect(
      pdfViewerFailureMessage(
        new Error("Unsupported image format"),
        "render",
        17
      )
    ).toBe("第 17 页渲染失败：Unsupported image format");
  });

  it("does not mistake an ordinary AbortError message for cancellation", () => {
    expect(
      pdfViewerFailureMessage(
        new Error("The PDF contains an AbortError annotation"),
        "render",
        1
      )
    ).toBe("第 1 页渲染失败：The PDF contains an AbortError annotation");
  });

  it("reports an unexpected worker failure when it has no cancellation type", () => {
    expect(
      pdfViewerFailureMessage(
        new Error("Worker was destroyed unexpectedly"),
        "load"
      )
    ).toBe("PDF 文件加载失败：Worker was destroyed unexpectedly");
  });
});
