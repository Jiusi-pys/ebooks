import { describe, expect, it } from "vitest";
import { associationPairKey, type PassageAnchor } from "./association";
import { normalizeReaderMirrorEvent } from "./mirror-event";
import { EVENT_TYPES, type EventType } from "./webhooks";

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
      bookExtId: "legacy-book",
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
        updatedAt: 1_800_000_000_000,
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
        updatedAt: 1_800_000_000_001,
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

  it("strictly validates the three internal book upload events", () => {
    expect(
      normalizeReaderMirrorEvent("book.import.started", {
        extId: "book-1",
        uploadId: "upload-1",
        chunkCount: 2,
        encodedBytes: 1024,
        title: "Large book",
        author: "",
        format: "txt",
        chapterCount: 1,
      }).success
    ).toBe(true);
    expect(
      normalizeReaderMirrorEvent("book.import.chunk", {
        extId: "book-1",
        uploadId: "upload-1",
        index: 1,
        chunkCount: 2,
        payload: "chunk",
      }).success
    ).toBe(true);
    expect(
      normalizeReaderMirrorEvent("book.import.completed", {
        extId: "book-1",
        uploadId: "upload-1",
        chunkCount: 2,
        encodedBytes: 1024,
      }).success
    ).toBe(true);

    expect(
      normalizeReaderMirrorEvent("book.import.chunk", {
        extId: "book-1",
        uploadId: "upload-1",
        index: 2,
        chunkCount: 2,
        payload: "out-of-range",
      }).success
    ).toBe(false);
    expect(
      normalizeReaderMirrorEvent("book.import.completed", {
        extId: "book-1",
        uploadId: "upload-1",
        chunkCount: 2,
        encodedBytes: 1024,
        unexpected: true,
      }).success
    ).toBe(false);
  });

  it("validates bounded book metadata updates", () => {
    expect(
      normalizeReaderMirrorEvent("book.updated", {
        extId: "book-1",
        title: "Updated title",
        author: "Author",
        metadata: {
          version: 1,
          publisher: "Example Press",
          languages: ["zh-Hans"],
          identifiers: [{ scheme: "ISBN", value: "9780000000001" }],
        },
      }).success
    ).toBe(true);
    expect(
      normalizeReaderMirrorEvent("book.updated", {
        extId: "book-1",
        metadata: { version: 1, unknown: true },
      }).success
    ).toBe(false);
    expect(
      normalizeReaderMirrorEvent("book.updated", { extId: "book-1" }).success
    ).toBe(false);
  });

  it("strictly validates every public reader event type", () => {
    const source: PassageAnchor = {
      kind: "text",
      bookId: "book-a",
      chapterId: "chapter-a",
      chapterTitle: "A",
      text: "source",
      paraIndex: 0,
      start: 0,
      end: 6,
    };
    const target: PassageAnchor = {
      ...source,
      bookId: "book-b",
      chapterId: "chapter-b",
      chapterTitle: "B",
      text: "target",
    };
    const association = {
      extId: "association-1",
      source,
      target,
      direction: "bidirectional",
      pairKey: associationPairKey(source, target, "bidirectional"),
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const review = {
      due: 3_000,
      reps: 1,
      lapses: 0,
      interval: 1,
      addedAt: 1_000,
    };
    const root = { id: "root", text: "Root", children: [] };
    const validByType: Record<EventType, Record<string, unknown>> = {
      "book.imported": {
        extId: "book-1",
        title: "Book",
        author: "Author",
        format: "txt",
        chapters: [{ id: "chapter-1", title: "One", paragraphs: ["Text"] }],
      },
      "book.updated": { extId: "book-1", title: "Renamed" },
      "book.deleted": { extId: "book-1", title: "Book" },
      "highlight.created": {
        extId: "highlight-1",
        bookExtId: "book-1",
        text: "Text",
      },
      "highlight.updated": { extId: "highlight-1", note: "Note" },
      "highlight.deleted": { extId: "highlight-1" },
      "association.created": association,
      "association.updated": { ...association, updatedAt: 3_000 },
      "association.deleted": { extId: "association-1" },
      "note.created": {
        extId: "note-1",
        title: "Note",
        content: "Body",
        updatedAt: 1_000,
      },
      "note.updated": {
        extId: "note-1",
        content: "Changed",
        updatedAt: 2_000,
      },
      "note.deleted": { extId: "note-1" },
      "qa.recorded": {
        extId: "highlight-1",
        question: "Why?",
        aiQa: [{ q: "Why?", a: "Because.", ts: 1_000 }],
      },
      "folder.created": { extId: "folder-1", name: "Research" },
      "folder.deleted": { extId: "folder-1", name: "Research" },
      "studyset.created": {
        extId: "set-1",
        name: "Set",
        bookIds: ["book-1"],
      },
      "studyset.updated": {
        extId: "set-1",
        name: "Set 2",
        description: "Focus",
        bookIds: ["book-1"],
      },
      "studyset.deleted": { extId: "set-1" },
      "translation.created": {
        extId: "translation-1",
        bookExtId: "book-1",
        targetLang: "中文",
        text: "译文",
      },
      "mindmap.created": {
        extId: "map-1",
        title: "Map",
        bookExtId: "book-1",
        root,
      },
      "mindmap.updated": { extId: "map-1", root },
      "mindmap.deleted": { extId: "map-1", title: "Map" },
      "highlight.tagged": { extId: "highlight-1", tags: ["important"] },
      "review.updated": {
        extId: "highlight-1",
        inReview: true,
        review,
      },
    };

    expect(Object.keys(validByType).sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) {
      const valid = validByType[type];
      expect(normalizeReaderMirrorEvent(type, valid).success, type).toBe(true);
      expect(
        normalizeReaderMirrorEvent(type, { ...valid, unexpected: true })
          .success,
        `${type} must reject unknown fields`
      ).toBe(false);
    }
    expect(normalizeReaderMirrorEvent("future.event", {}).success).toBe(false);
  });
});
