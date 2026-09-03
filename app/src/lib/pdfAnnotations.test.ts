import { describe, expect, it } from "vitest";
import type { Highlight } from "@/types";
import {
  createPdfHighlightAnchor,
  findPdfAnnotationAtPoint,
  normalizePdfSelectionRects,
  pdfAnnotationsForPage,
  sanitizePdfAnchorRects,
  stackPdfAssociationBadges,
} from "./pdfAnnotations";

const page = { left: 100, top: 50, width: 400, height: 800 };

function highlight(id: string, pageNumber: number): Highlight {
  return {
    id,
    bookId: "book",
    chapterId: "chapter",
    chapterTitle: "PDF",
    text: id,
    pdfAnchor: {
      page: pageNumber,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    },
    createdAt: 1,
  };
}

describe("PDF annotation geometry", () => {
  it("normalizes every line in a multi-line browser selection", () => {
    expect(
      normalizePdfSelectionRects(
        [
          { left: 140, top: 210, width: 120, height: 20 },
          { left: 120, top: 240, width: 240, height: 20 },
        ],
        page
      )
    ).toEqual([
      { x: 0.1, y: 0.2, width: 0.3, height: 0.025 },
      { x: 0.05, y: 0.2375, width: 0.6, height: 0.025 },
    ]);
  });

  it("clips selection rectangles to the page and ignores invalid entries", () => {
    expect(
      normalizePdfSelectionRects(
        [
          { left: 80, top: 40, width: 60, height: 30 },
          { left: 600, top: 900, width: 20, height: 20 },
          { left: 120, top: 100, width: Number.NaN, height: 20 },
        ],
        page
      )
    ).toEqual([{ x: 0, y: 0, width: 0.1, height: 0.025 }]);
  });

  it("keeps the same normalized anchor at different zoom levels", () => {
    const oneX = normalizePdfSelectionRects(
      [{ left: 140, top: 210, width: 120, height: 20 }],
      page
    );
    const twoX = normalizePdfSelectionRects(
      [{ left: 280, top: 420, width: 240, height: 40 }],
      { left: 200, top: 100, width: 800, height: 1600 }
    );
    expect(twoX).toEqual(oneX);
  });

  it("creates anchors only for valid pages and non-empty geometry", () => {
    expect(
      createPdfHighlightAnchor(
        3,
        [{ left: 140, top: 210, width: 120, height: 20 }],
        page
      )
    ).toEqual({
      page: 3,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.025 }],
    });
    expect(createPdfHighlightAnchor(0, [], page)).toBeNull();
    expect(createPdfHighlightAnchor(1, [], page)).toBeNull();
  });

  it("sanitizes stored rectangles and filters annotations by page", () => {
    expect(
      sanitizePdfAnchorRects([
        { x: -0.1, y: 0.9, width: 0.4, height: 0.3 },
        { x: 0.2, y: 0.2, width: -1, height: 0.2 },
      ])
    ).toEqual([{ x: 0, y: 0.9, width: 0.3, height: 0.1 }]);

    const current = highlight("current", 2);
    expect(pdfAnnotationsForPage([highlight("other", 1), current], 2)).toEqual([
      { highlight: current, rects: current.pdfAnchor!.rects },
    ]);
  });

  it("hit-tests newest annotations in input order", () => {
    const first = highlight("first", 1);
    const second = highlight("second", 1);
    const annotations = pdfAnnotationsForPage([first, second], 1);
    expect(findPdfAnnotationAtPoint(annotations, 0.2, 0.22)).toBe(first);
    expect(findPdfAnnotationAtPoint(annotations, 0.9, 0.9)).toBeNull();
  });

  it("stacks association badges that share a PDF endpoint", () => {
    const shared = { x: 0.1, y: 0.2, width: 0.3, height: 0.04 };
    const positioned = stackPdfAssociationBadges([
      { key: "first", anchor: { page: 1, rects: [shared] } },
      {
        key: "second",
        anchor: {
          page: 1,
          rects: [{ x: 0.05, y: 0.1, width: 0.2, height: 0.03 }, shared],
        },
      },
      {
        key: "elsewhere",
        anchor: {
          page: 1,
          rects: [{ x: 0.2, y: 0.4, width: 0.3, height: 0.04 }],
        },
      },
    ]);

    expect(positioned.map(item => item.stackIndex)).toEqual([0, 1, 0]);
  });

  it("groups by clipped display coordinates and stacks away from page edges", () => {
    const positioned = stackPdfAssociationBadges([
      {
        key: "right-a",
        anchor: {
          page: 1,
          rects: [{ x: 0.98, y: 0.4, width: 0.01, height: 0.04 }],
        },
      },
      {
        key: "right-b",
        anchor: {
          page: 1,
          rects: [{ x: 0.975, y: 0.4, width: 0.02, height: 0.04 }],
        },
      },
      {
        key: "top-a",
        anchor: {
          page: 1,
          rects: [{ x: 0.2, y: 0, width: 0.2, height: 0.01 }],
        },
      },
      {
        key: "top-b",
        anchor: {
          page: 1,
          rects: [{ x: 0.2, y: 0.005, width: 0.2, height: 0.01 }],
        },
      },
      {
        key: "bottom",
        anchor: {
          page: 1,
          rects: [{ x: 0.2, y: 0.97, width: 0.2, height: 0.03 }],
        },
      },
    ]);

    expect(positioned.slice(0, 2).map(item => item.stackIndex)).toEqual([0, 1]);
    expect(positioned.slice(2, 4).map(item => item.stackIndex)).toEqual([0, 1]);
    expect(positioned[2].stackDirection).toBe("down");
    expect(positioned[4].stackDirection).toBe("up");
  });
});
