import { describe, expect, it } from "vitest";
import {
  associationPairKey as browserAssociationPairKey,
  passageAnchorKey as browserPassageAnchorKey,
} from "@/lib/associations";
import {
  associationDbValues,
  associationFromRow,
  associationPairKey,
  associationPairKeyHash,
  associationSchema,
  passageAnchorKey,
  resolveAssociationPatch,
  type AssociationSnapshot,
  type PassageAnchor,
} from "./association";

const source: PassageAnchor = {
  kind: "text",
  bookId: "book-a",
  chapterId: "chapter-a",
  chapterTitle: "第一章",
  text: "学而不思则罔",
  paraIndex: 3,
  start: 2,
  end: 9,
};

const target: PassageAnchor = {
  kind: "text",
  bookId: "book-b",
  chapterId: "chapter-b",
  chapterTitle: "第二章",
  text: "思而不学则殆",
  paraIndex: 5,
  start: 1,
  end: 8,
};

function association(
  direction: AssociationSnapshot["direction"] = "bidirectional"
): AssociationSnapshot {
  return {
    extId: "association-1",
    source,
    target,
    direction,
    label: "互文",
    pairKey: associationPairKey(source, target, direction),
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

describe("passage association contract", () => {
  it("uses an unordered pair key for bidirectional links", () => {
    expect(associationPairKey(source, target, "bidirectional")).toBe(
      associationPairKey(target, source, "bidirectional")
    );
    expect(associationPairKey(source, target, "source-to-target")).not.toBe(
      associationPairKey(target, source, "source-to-target")
    );
    expect(passageAnchorKey(source)).toBe(browserPassageAnchorKey(source));
    expect(associationPairKey(source, target, "bidirectional")).toBe(
      browserAssociationPairKey(source, target, "bidirectional")
    );
  });

  it("canonicalizes PDF rectangles to six decimals and ignores their order", () => {
    const first: PassageAnchor = {
      kind: "pdf",
      bookId: "book-pdf",
      chapterId: "page-3",
      chapterTitle: "第 3 页",
      text: "多行选区",
      pdfAnchor: {
        page: 3,
        rects: [
          { x: 0.1, y: 0.4, width: 0.2, height: 0.03000001 },
          { x: 0.1, y: 0.3, width: 0.4, height: 0.03 },
        ],
      },
    };
    const reversed: PassageAnchor = {
      ...first,
      text: "显示快照可以不同",
      pdfAnchor: {
        page: 3,
        rects: [...first.pdfAnchor.rects].reverse(),
      },
    };

    expect(passageAnchorKey(first)).toBe(passageAnchorKey(reversed));
    expect(passageAnchorKey(first)).toBe(browserPassageAnchorKey(first));
  });

  it("rejects self-links, mismatched pair keys, and mixed anchor fields", () => {
    expect(
      associationSchema.safeParse({
        ...association(),
        target: { ...source },
        pairKey: associationPairKey(source, source, "bidirectional"),
      }).success
    ).toBe(false);
    expect(
      associationSchema.safeParse({ ...association(), pairKey: "forged" })
        .success
    ).toBe(false);
    expect(
      associationSchema.safeParse({
        ...association(),
        source: { ...source, pdfAnchor: { page: 1, rects: [] } },
      }).success
    ).toBe(false);
  });

  it("recomputes keys on patches and validates caller-supplied keys", () => {
    const directed = resolveAssociationPatch(
      association(),
      { direction: "source-to-target", label: null },
      3_000
    );
    expect(directed).toEqual({
      success: true,
      data: {
        ...association(),
        direction: "source-to-target",
        label: undefined,
        pairKey: associationPairKey(source, target, "source-to-target"),
        updatedAt: 3_000,
      },
    });
    expect(
      resolveAssociationPatch(association(), {
        direction: "source-to-target",
        pairKey: association().pairKey,
      }).success
    ).toBe(false);
  });

  it("round-trips flattened text/PDF rows without weakening the schema", () => {
    const pdfTarget: PassageAnchor = {
      kind: "pdf",
      bookId: "book-pdf",
      chapterId: "page-9",
      chapterTitle: "第 9 页",
      text: "目标 PDF 文段",
      pdfAnchor: {
        page: 9,
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      },
    };
    const snapshot: AssociationSnapshot = {
      ...association(),
      target: pdfTarget,
      pairKey: associationPairKey(source, pdfTarget, "bidirectional"),
    };
    const values = associationDbValues(snapshot);

    expect(values).toMatchObject({
      sourceKind: "text",
      sourceBookExtId: "book-a",
      sourceParaIndex: 3,
      sourcePdfAnchor: null,
      targetKind: "pdf",
      targetBookExtId: "book-pdf",
      targetParaIndex: null,
      pairKeyHash: associationPairKeyHash(snapshot.pairKey),
    });
    expect(associationFromRow(values)).toEqual(snapshot);
    expect(values.pairKeyHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
