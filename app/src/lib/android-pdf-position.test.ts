import { describe, expect, it } from "vitest";
import { pdfScrollPosition, pdfScrollOffset } from "../../../platforms/android/web/pdf-position";

describe("PDF comparison positions", () => {
  it("retains the within-page offset independently of viewport size", () => {
    expect(pdfScrollPosition(3, 12, -400, 800)).toEqual({ page: 3, pages: 12, fraction: 0.5 });
    expect(pdfScrollOffset(1200, 600, 0.5)).toBe(1500);
  });
  it("clamps edge overscroll and rejects nonfinite geometry", () => {
    expect(pdfScrollPosition(1, 1, 30, 800).fraction).toBe(0);
    expect(pdfScrollPosition(1, 1, -900, 800).fraction).toBe(1);
    expect(() => pdfScrollPosition(1, 0, 0, 0)).toThrow();
    expect(() => pdfScrollOffset(0, 100, NaN)).toThrow();
  });
});
