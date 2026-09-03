import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  citationCreateShape,
  parseStoredCitationLevel,
  parseStoredPdfAnchor,
  resolveCitationPatch,
  serializePdfAnchor,
  validateCitationCreate,
} from "./highlight-citation";

const createSchema = z
  .object(citationCreateShape)
  .strict()
  .superRefine(validateCitationCreate);

const contentCitation = {
  citationLevel: "content" as const,
  chapterId: "chapter-1",
  paraIndex: 4,
  start: 2,
  end: 9,
  pdfAnchor: null,
};

describe("citation mirror validation", () => {
  it("keeps legacy requests as content citations", () => {
    expect(createSchema.parse({})).toEqual({
      citationLevel: "content",
      chapterId: "",
    });
  });

  it("accepts book, chapter, text, and PDF hierarchy anchors", () => {
    expect(createSchema.parse({ citationLevel: "book" })).toMatchObject({
      citationLevel: "book",
    });
    expect(
      createSchema.parse({ citationLevel: "chapter", chapterId: "chapter-1" })
    ).toMatchObject({ citationLevel: "chapter", chapterId: "chapter-1" });
    expect(
      createSchema.parse({
        ...contentCitation,
        pdfAnchor: {
          page: 12,
          rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
        },
      })
    ).toMatchObject({ citationLevel: "content", paraIndex: 4 });
  });

  it("rejects inconsistent hierarchy and unknown input", () => {
    expect(() => createSchema.parse({ citationLevel: "chapter" })).toThrow();
    expect(() =>
      createSchema.parse({ citationLevel: "book", chapterId: "chapter-1" })
    ).toThrow();
    expect(() =>
      createSchema.parse({ citationLevel: "content", start: 3 })
    ).toThrow();
    expect(() =>
      createSchema.parse({ citationLevel: "content", extra: true })
    ).toThrow();
  });

  it("validates normalized PDF geometry", () => {
    expect(() =>
      createSchema.parse({
        citationLevel: "content",
        pdfAnchor: {
          page: 1,
          rects: [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }],
        },
      })
    ).toThrow(/x \+ width/);
  });
});

describe("citation mirror persistence helpers", () => {
  it("clears lower-level anchors when moving to book or chapter", () => {
    expect(
      resolveCitationPatch(contentCitation, { citationLevel: "book" })
    ).toEqual({
      success: true,
      data: {
        citationLevel: "book",
        chapterId: "",
        paraIndex: null,
        start: null,
        end: null,
        pdfAnchor: null,
      },
    });

    expect(
      resolveCitationPatch(contentCitation, {
        citationLevel: "chapter",
        chapterId: "chapter-2",
      })
    ).toEqual({
      success: true,
      data: {
        citationLevel: "chapter",
        chapterId: "chapter-2",
        paraIndex: null,
        start: null,
        end: null,
        pdfAnchor: null,
      },
    });
  });

  it("merges partial content anchors and rejects broken ranges", () => {
    expect(resolveCitationPatch(contentCitation, { end: 12 })).toMatchObject({
      success: true,
      data: { start: 2, end: 12 },
    });
    expect(resolveCitationPatch(contentCitation, { start: null })).toEqual({
      success: false,
      message: "start and end must be supplied together",
    });
    expect(
      resolveCitationPatch(contentCitation, {
        citationLevel: "book",
        paraIndex: 2,
      })
    ).toMatchObject({ success: false });
  });

  it("round-trips valid PDF JSON and safely ignores corrupt stored data", () => {
    const anchor = {
      page: 2,
      rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.1 }],
    };
    expect(parseStoredPdfAnchor(serializePdfAnchor(anchor))).toEqual(anchor);
    expect(parseStoredPdfAnchor("not json")).toBeNull();
    expect(parseStoredCitationLevel("future-level")).toBe("content");
  });
});
