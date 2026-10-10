import { describe, expect, it } from "vitest";
import { pdfRectGeometry } from "../../../platforms/android/web/pdf-annotations";

describe("PDF annotations keep their position after export", () => {
  it("uses the unrotated crop box and keeps the underline on the selected bottom edge", () => {
    expect(pdfRectGeometry({ x: .1, y: .2, width: .3, height: .1 }, { x: 20, y: 30, width: 500, height: 800 }, 0)).toEqual({
      x: 70, y: 590, width: 150, height: 80,
      line: [{ x: 70, y: 590 }, { x: 220, y: 590 }],
    });
  });
  it("rotates the underline with a 90 degree page rather than drawing a horizontal bounding edge", () => {
    const result = pdfRectGeometry({ x: .1, y: .2, width: .3, height: .1 }, { x: 20, y: 30, width: 500, height: 800 }, 90);
    expect(result.line[0].x).toBeCloseTo(170);
    expect(result.line[1].x).toBeCloseTo(170);
    expect(result.line[0].y).toBeCloseTo(110);
    expect(result.line[1].y).toBeCloseTo(350);
  });
  it("rejects invalid coordinates before modifying the output PDF", () => {
    expect(() => pdfRectGeometry({ x: -1, y: .2, width: .3, height: .1 }, { x: 0, y: 0, width: 500, height: 800 }, 0)).toThrow();
    expect(() => pdfRectGeometry({ x: .9, y: .2, width: .3, height: .1 }, { x: 0, y: 0, width: 500, height: 800 }, 0)).toThrow();
  });
});
