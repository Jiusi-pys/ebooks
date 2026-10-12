import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Highlight, TextPassageAnchor } from "@/types";
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
  it("preserves inline images once at highlight boundaries and paragraph end", () => {
    const html = renderToStaticMarkup(
      createElement(Paragraph, {
        index: 4,
        text: "A😀BC",
        ranges: [],
        associationRanges: [
          { anchor: anchor(3, 5), associationIds: ["a"], start: 3, end: 5 },
        ],
        images: [3, 5].map((offset, order) => ({
          offset,
          order,
          assetId: "image",
          alt: `图${order}`,
          asset: {
            dataUrl: "data:image/png;base64,AAAA",
            mediaType: "image/png",
          },
        })),
        epubRole: "caption",
        recall: false,
        onSegmentClick: vi.fn(),
        onAssociationClick: vi.fn(),
      })
    );
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('data-pi="4"');
    expect(html).toContain('class="reader-epub-caption"');
    expect(html).toMatch(
      /A😀<\/span>.*<img [^>]*alt="图0"[^>]*\/>BC<img [^>]*alt="图1"/
    );
  });

  it("marks the full passage carrying an AI answer", () => {
    const highlight: Highlight = {
      id: "highlight-qa",
      bookId: "book-1",
      chapterId: "chapter-1",
      chapterTitle: "第一章",
      text: "bcdefg",
      style: { kind: "none", color: "blue" },
      aiQa: [{ q: "为什么？", a: "因为如此。", ts: 1 }],
      createdAt: 1,
    };
    const html = renderToStaticMarkup(
      createElement(Paragraph, {
        index: 0,
        text: "abcdefghij",
        ranges: [{ h: highlight, start: 1, end: 7 }],
        associationRanges: [],
        recall: false,
        onSegmentClick: vi.fn(),
        onAssociationClick: vi.fn(),
      })
    );

    expect(html).toMatch(/class="[^"]*hl-ai-qa[^"]*"[^>]*>bcdefg<svg/);
  });

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
