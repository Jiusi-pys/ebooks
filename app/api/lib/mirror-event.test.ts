import { describe, expect, it } from "vitest";
import { associationPairKey, type PassageAnchor } from "./association";
import { normalizeReaderMirrorEvent } from "./mirror-event";

describe("normalizeReaderMirrorEvent", () => {
  it("keeps every content anchor and normalizes legacy noteId", () => {
    const result = normalizeReaderMirrorEvent("highlight.created", {
      extId: "highlight-1",
      bookExtId: "book-1",
      bookTitle: "Example",
      citationLevel: "content",
      chapterId: "chapter-1",
      chapterTitle: "Chapter 1",
      text: "selected text",
      paraIndex: 3,
      start: 4,
      end: 17,
      pdfAnchor: {
        page: 8,
        rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }],
      },
      noteId: "note-1",
      styleKind: "none",
      styleColor: "orange",
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        citationLevel: "content",
        chapterId: "chapter-1",
        paraIndex: 3,
        start: 4,
        end: 17,
        noteExtId: "note-1",
      },
    });
    if (result.success) expect(result.data).not.toHaveProperty("noteId");
  });

  it("defaults old highlight events to content without inventing anchors", () => {
    const result = normalizeReaderMirrorEvent("highlight.created", {
      extId: "legacy-highlight",
      bookTitle: "Legacy",
      chapterTitle: "Chapter",
      text: "old text",
    });

    expect(result).toMatchObject({
      success: true,
      data: { citationLevel: "content", chapterId: "" },
    });
  });

  it("allows null to unlink a note and clear optional anchors", () => {
    expect(
      normalizeReaderMirrorEvent("highlight.updated", {
        extId: "highlight-1",
        noteExtId: null,
        paraIndex: null,
        start: null,
        end: null,
        pdfAnchor: null,
      })
    ).toMatchObject({
      success: true,
      data: { noteExtId: null, pdfAnchor: null },
    });
  });

  it("rejects malformed known fields and conflicting note aliases", () => {
    expect(
      normalizeReaderMirrorEvent("highlight.created", {
        extId: "highlight-1",
        text: "text",
        citationLevel: "chapter",
      }).success
    ).toBe(false);
    expect(
      normalizeReaderMirrorEvent("highlight.updated", {
        extId: "highlight-1",
        noteExtId: "note-a",
        noteId: "note-b",
      }).success
    ).toBe(false);
  });

  it("requires complete note snapshots for create and useful updates", () => {
    expect(
      normalizeReaderMirrorEvent("note.created", {
        extId: "note-1",
        title: "Citation note",
        content: "Quoted content",
      }).success
    ).toBe(true);
    expect(
      normalizeReaderMirrorEvent("note.created", {
        extId: "note-1",
        title: "Citation note",
      }).success
    ).toBe(false);
    expect(
      normalizeReaderMirrorEvent("note.updated", {
        extId: "note-1",
        content: "Updated content",
      }).success
    ).toBe(true);
    expect(
      normalizeReaderMirrorEvent("note.updated", { extId: "note-1" }).success
    ).toBe(false);
  });

  it("strictly validates full association create and update snapshots", () => {
    const source: PassageAnchor = {
      kind: "text",
      bookId: "book-a",
      chapterId: "chapter-a",
      chapterTitle: "第一章",
      text: "源文段",
      paraIndex: 1,
      start: 0,
      end: 3,
    };
    const target: PassageAnchor = {
      kind: "text",
      bookId: "book-b",
      chapterId: "chapter-b",
      chapterTitle: "第二章",
      text: "目标文段",
      paraIndex: 2,
      start: 4,
      end: 8,
    };
    const data = {
      extId: "association-1",
      source,
      target,
      direction: "bidirectional",
      label: "相似观点",
      pairKey: associationPairKey(source, target, "bidirectional"),
      createdAt: 1_000,
      updatedAt: 2_000,
    };

    expect(
      normalizeReaderMirrorEvent("association.created", data)
    ).toMatchObject({ success: true, data });
    expect(
      normalizeReaderMirrorEvent("association.updated", {
        ...data,
        updatedAt: 3_000,
      })
    ).toMatchObject({ success: true });
    expect(
      normalizeReaderMirrorEvent("association.updated", {
        ...data,
        unexpected: true,
      }).success
    ).toBe(false);
    expect(
      normalizeReaderMirrorEvent("association.updated", {
        extId: "association-1",
        label: "partial snapshots are forbidden",
      }).success
    ).toBe(false);
  });

  it("accepts only an extId for association deletion", () => {
    expect(
      normalizeReaderMirrorEvent("association.deleted", {
        extId: "association-1",
      })
    ).toEqual({ success: true, data: { extId: "association-1" } });
    expect(
      normalizeReaderMirrorEvent("association.deleted", {
        extId: "association-1",
        citationLevel: "content",
      }).success
    ).toBe(false);
  });
});
