import { describe, expect, it } from "vitest";
import type {
  Association,
  Book,
  Highlight,
  PassageAnchor,
  PdfPassageAnchor,
  TextPassageAnchor,
} from "@/types";
import {
  associationCandidatesForChapter,
  associationPairKey,
  associationPeer,
  associationsForAnchor,
  associationsForBook,
  assertAssociationEndpoints,
  isPdfPassageAnchor,
  isTextPassageAnchor,
  passageAnchorFromHighlight,
  passageAnchorKey,
  targetSentenceCandidates,
  validateAssociationEndpoints,
  validatePassageAnchor,
} from "./associations";

const source: TextPassageAnchor = {
  kind: "text",
  bookId: "book-a",
  chapterId: "chapter-a",
  chapterTitle: "第一章",
  text: "相似的句子。",
  paraIndex: 2,
  start: 4,
  end: 10,
};

const target: TextPassageAnchor = {
  kind: "text",
  bookId: "book-b",
  chapterId: "chapter-b",
  chapterTitle: "Second",
  text: "A related sentence.",
  paraIndex: 1,
  start: 0,
  end: 19,
};

function relation(overrides: Partial<Association> = {}): Association {
  return {
    id: "association-1",
    source,
    target,
    direction: "bidirectional",
    pairKey: associationPairKey(source, target),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("association identity", () => {
  it("uses location rather than mutable text snapshots", () => {
    expect(
      passageAnchorKey({
        ...source,
        chapterTitle: "Renamed",
        text: "Display text changed",
      })
    ).toBe(passageAnchorKey(source));
  });

  it("normalizes PDF rect order and renderer-scale float noise", () => {
    const first: PdfPassageAnchor = {
      kind: "pdf",
      bookId: "pdf",
      chapterId: "pdf-root",
      chapterTitle: "PDF",
      text: "selection",
      pdfAnchor: {
        page: 3,
        rects: [
          { x: 0.1, y: 0.4, width: 0.2, height: 0.03 },
          { x: 0.1, y: 0.3, width: 0.4, height: 0.03 },
        ],
      },
    };
    const second: PdfPassageAnchor = {
      ...first,
      text: "different snapshot",
      pdfAnchor: {
        page: 3,
        rects: [...first.pdfAnchor.rects]
          .reverse()
          .map(rect => ({ ...rect, x: rect.x + 0.0000001 })),
      },
    };

    expect(passageAnchorKey(second)).toBe(passageAnchorKey(first));
  });

  it("deduplicates reverse bidirectional pairs but preserves direction", () => {
    expect(associationPairKey(source, target)).toBe(
      associationPairKey(target, source)
    );
    expect(associationPairKey(source, target, "source-to-target")).not.toBe(
      associationPairKey(target, source, "source-to-target")
    );
  });

  it("rejects a self association", () => {
    expect(validateAssociationEndpoints(source, { ...source })).toMatch(
      /itself/
    );
    expect(() => assertAssociationEndpoints(source, source)).toThrow(TypeError);
  });
});

describe("association anchors", () => {
  it("validates text and PDF invariants", () => {
    expect(validatePassageAnchor(source)).toBeNull();
    expect(validatePassageAnchor({ ...source, end: source.start })).toMatch(
      /greater/
    );
    const outsidePage: PdfPassageAnchor = {
      kind: "pdf",
      bookId: "pdf",
      chapterId: "root",
      chapterTitle: "PDF",
      text: "selection",
      pdfAnchor: {
        page: 1,
        rects: [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }],
      },
    };
    expect(validatePassageAnchor(outsidePage)).toMatch(/inside/);
  });

  it("matches the mirror API bounds before local persistence", () => {
    expect(
      validatePassageAnchor({ ...source, bookId: "b".repeat(65) })
    ).toMatch(/64/);
    expect(
      validatePassageAnchor({ ...source, text: "x".repeat(20_001) })
    ).toMatch(/20000/);
    expect(validatePassageAnchor({ ...source, paraIndex: 20_000_001 })).toMatch(
      /20000000/
    );

    const pdf: PdfPassageAnchor = {
      kind: "pdf",
      bookId: "pdf",
      chapterId: "root",
      chapterTitle: "PDF",
      text: "selection",
      pdfAnchor: {
        page: 1_000_001,
        rects: [{ x: 0, y: 0, width: 0.1, height: 0.1 }],
      },
    };
    expect(validatePassageAnchor(pdf)).toMatch(/1000000/);
    expect(
      validatePassageAnchor({
        ...pdf,
        pdfAnchor: {
          page: 1,
          rects: Array.from({ length: 257 }, () => ({
            x: 0,
            y: 0,
            width: 0.1,
            height: 0.1,
          })),
        },
      })
    ).toMatch(/256/);
  });

  it("narrows each discriminated anchor kind", () => {
    const pdf: PassageAnchor = {
      kind: "pdf",
      bookId: "pdf",
      chapterId: "root",
      chapterTitle: "PDF",
      text: "selection",
      pdfAnchor: {
        page: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }],
      },
    };
    expect(isTextPassageAnchor(source)).toBe(true);
    expect(isPdfPassageAnchor(pdf)).toBe(true);
  });

  it("converts only precise content highlights", () => {
    const highlight: Highlight = {
      id: "highlight",
      bookId: source.bookId,
      chapterId: source.chapterId,
      chapterTitle: source.chapterTitle,
      text: source.text,
      paraIndex: source.paraIndex,
      start: source.start,
      end: source.end,
      createdAt: 1,
    };
    expect(passageAnchorFromHighlight(highlight)).toEqual(source);
    expect(
      passageAnchorFromHighlight({
        ...highlight,
        citation: { level: "chapter", chapterId: source.chapterId },
      })
    ).toBeNull();
    expect(
      passageAnchorFromHighlight({
        ...highlight,
        paraIndex: undefined,
        start: undefined,
        end: undefined,
      })
    ).toBeNull();
  });
});

describe("association lookup", () => {
  it("finds the opposite endpoint and relevant records", () => {
    const association = relation();
    expect(associationPeer(association, source)).toEqual(target);
    expect(associationPeer(association, target)).toEqual(source);
    expect(
      associationPeer(association, { ...source, paraIndex: 99 })
    ).toBeNull();
    expect(associationsForAnchor([association], source)).toEqual([association]);
    expect(associationsForBook([association], "book-b")).toEqual([association]);
  });
});

describe("target sentence candidates", () => {
  const book = {
    id: "book",
    chapters: [
      {
        id: "chapter-1",
        title: "中英句子",
        paragraphs: ["第一句。 第二句！", "First sentence. Next sentence?"],
      },
      { id: "chapter-2", title: "另一章", paragraphs: ["最后一句。"] },
    ],
  } satisfies Pick<Book, "id" | "chapters">;

  it("keeps exact paragraph offsets while splitting sentences", () => {
    const candidates = targetSentenceCandidates(book, {
      chapterId: "chapter-1",
    });
    expect(candidates.map(candidate => candidate.text)).toEqual([
      "第一句。",
      "第二句！",
      "First sentence.",
      "Next sentence?",
    ]);
    expect(candidates[1]).toMatchObject({
      paraIndex: 0,
      start: 5,
      end: 9,
    });
  });

  it("filters by query and caps results", () => {
    expect(
      targetSentenceCandidates(book, { query: "sentence", limit: 1 })
    ).toHaveLength(1);
    expect(
      associationCandidatesForChapter("book", book.chapters[1], {
        query: "最后",
      })
    ).toEqual([
      {
        kind: "text",
        bookId: "book",
        chapterId: "chapter-2",
        chapterTitle: "另一章",
        text: "最后一句。",
        paraIndex: 0,
        start: 0,
        end: 5,
      },
    ]);
  });
});
