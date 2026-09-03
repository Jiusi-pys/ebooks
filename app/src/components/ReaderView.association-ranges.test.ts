import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TextPassageAnchor } from "@/types";
import { passageAnchorKey } from "@/lib/associations";
import { Paragraph } from "./ReaderView";

vi.mock("./reader/PdfCanvasViewer", () => ({
  PdfCanvasViewer: () => null,
}));

function anchor(start: number, end: number): TextPassageAnchor {
  return {
    kind: "text",
    bookId: "book-1",
    chapterId: "chapter-1",
    chapterTitle: "第一章",
    text: "abcdefghij".slice(start, end),
    paraIndex: 0,
    start,
    end,
  };
}

function renderRanges(items: TextPassageAnchor[]): string {
  return renderToStaticMarkup(
    createElement(Paragraph, {
      index: 0,
      text: "abcdefghij",
      ranges: [],
      associationRanges: items.map((item, index) => ({
        anchor: item,
        associationIds: [`association-${index}`],
        start: item.start,
        end: item.end,
      })),
      recall: false,
      onSegmentClick: vi.fn(),
      onAssociationClick: vi.fn(),
    })
  );
}

describe("Paragraph association ranges", () => {
  it("keeps every anchor key on segments shared by nested associations", () => {
    const outer = anchor(0, 10);
    const nested = anchor(2, 8);
    const html = renderRanges([outer, nested]);
    const attributes = Array.from(
      html.matchAll(/data-association-anchor-keys="([^"]+)"/g),
      match => match[1]
    );

    expect(
      attributes.some(
        value =>
          value.includes(passageAnchorKey(outer)) &&
          value.includes(passageAnchorKey(nested))
      )
    ).toBe(true);
  });

  it("renders a separate management button for distinct anchors ending together", () => {
    const outer = anchor(0, 10);
    const suffix = anchor(2, 10);
    const html = renderRanges([outer, suffix]);

    expect(html).toContain(
      `data-association-anchor-key="${passageAnchorKey(outer)}"`
    );
    expect(html).toContain(
      `data-association-anchor-key="${passageAnchorKey(suffix)}"`
    );
    expect(html.match(/class="association-ball/g)).toHaveLength(2);
  });
});
