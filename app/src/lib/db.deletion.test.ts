import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Association,
  Book,
  ChapterTranslation,
  Highlight,
  MindMap,
  Note,
  StudySet,
} from "@/types";
import {
  closeDatabaseConnection,
  deleteBook,
  deleteHighlightsWithCitationCleanup,
  deleteNote,
  getAllAssociations,
  getAllBooks,
  getAllMindMaps,
  getAllStudySets,
  getChapterTranslation,
  getFile,
  getHighlights,
  getAllNotes,
  putAssociation,
  putBook,
  putChapterTranslation,
  putHighlight,
  putImportedBook,
  putMindMap,
  putNote,
  putStudySet,
  SHUFANG_DB_NAME,
  translationId,
} from "./db";
import { citationBlock } from "./citations";

function resetDatabase() {
  closeDatabaseConnection();
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SHUFANG_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("test database deletion blocked"));
    request.onsuccess = () => resolve();
  });
}

function book(id: string): Book {
  return {
    id,
    title: id,
    author: "",
    format: "pdf",
    coverTone: 0,
    chapters: [{ id: `${id}-chapter`, title: "Chapter", paragraphs: ["Text"] }],
    createdAt: 1,
    progress: { chapterId: `${id}-chapter`, ratio: 0 },
  };
}

function highlight(id: string, bookId: string): Highlight {
  return {
    id,
    bookId,
    chapterId: `${bookId}-chapter`,
    chapterTitle: "Chapter",
    text: "Text",
    style: { kind: "underline", color: "orange" },
    createdAt: 1,
  };
}

function association(
  id: string,
  sourceBookId: string,
  targetBookId: string
): Association {
  return {
    id,
    source: {
      kind: "text",
      bookId: sourceBookId,
      chapterId: `${sourceBookId}-chapter`,
      chapterTitle: "Chapter",
      text: "Source",
      paraIndex: 0,
      start: 0,
      end: 6,
    },
    target: {
      kind: "text",
      bookId: targetBookId,
      chapterId: `${targetBookId}-chapter`,
      chapterTitle: "Chapter",
      text: "Target",
      paraIndex: 0,
      start: 0,
      end: 6,
    },
    direction: "bidirectional",
    pairKey: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

function translation(id: string, bookId: string): ChapterTranslation {
  return {
    id,
    bookId,
    chapterId: `${bookId}-chapter`,
    targetLang: "English",
    text: "Translation",
    createdAt: 1,
    updatedAt: 1,
  };
}

function mindMap(id: string, bookId: string): MindMap {
  return {
    id,
    title: id,
    bookId,
    root: { id: `${id}-root`, text: "Root", children: [] },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("local book deletion cascade", () => {
  beforeEach(resetDatabase);
  afterEach(resetDatabase);

  it("removes every book-owned record while preserving unrelated data", async () => {
    const deletedId = "delete-me";
    const keptId = "keep-me";
    const thirdId = "third-book";
    await putImportedBook(book(deletedId), {
      id: deletedId,
      type: "pdf",
      data: new ArrayBuffer(8),
    });
    await putBook(book(keptId));
    await putHighlight(highlight("deleted-highlight", deletedId));
    await putHighlight(highlight("kept-highlight", keptId));
    await putAssociation(association("deleted-source", deletedId, keptId));
    await putAssociation(association("deleted-target", keptId, deletedId));
    await putAssociation(association("kept-association", keptId, thirdId));
    const deletedTranslationId = translationId(
      deletedId,
      `${deletedId}-chapter`,
      "English"
    );
    const keptTranslationId = translationId(
      keptId,
      `${keptId}-chapter`,
      "English"
    );
    await putChapterTranslation(translation(deletedTranslationId, deletedId));
    await putChapterTranslation(translation(keptTranslationId, keptId));
    await putMindMap(mindMap("deleted-map", deletedId));
    await putMindMap(mindMap("kept-map", keptId));
    const studySet: StudySet = {
      id: "set",
      name: "Set",
      bookIds: [deletedId, keptId],
      createdAt: 1,
      updatedAt: 1,
    };
    await putStudySet(studySet);

    await deleteBook(deletedId);

    expect((await getAllBooks()).map(item => item.id)).toEqual([keptId]);
    expect(await getFile(deletedId)).toBeUndefined();
    expect((await getHighlights()).map(item => item.id)).toEqual([
      "kept-highlight",
    ]);
    expect((await getAllAssociations()).map(item => item.id)).toEqual([
      "kept-association",
    ]);
    expect(
      await getChapterTranslation(deletedId, `${deletedId}-chapter`, "English")
    ).toBeUndefined();
    expect(
      await getChapterTranslation(keptId, `${keptId}-chapter`, "English")
    ).toEqual(translation(keptTranslationId, keptId));
    expect((await getAllMindMaps()).map(item => item.id)).toEqual(["kept-map"]);
    expect(await getAllStudySets()).toEqual([
      {
        ...studySet,
        bookIds: [keptId],
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("upgrades a surviving legacy citation after deleting an identical peer", async () => {
    const deletedBook = { ...book("delete-citation"), title: "Shared" };
    const keptBook = { ...book("keep-citation"), title: "Shared" };
    const note: Note = {
      id: "citation-note",
      title: "Citations",
      content: citationBlock({
        level: "content",
        bookTitle: "Shared",
        chapterTitle: "Chapter",
        text: "Text",
      }),
      createdAt: 1,
      updatedAt: 1,
    };
    await putBook(deletedBook);
    await putBook(keptBook);
    await putNote(note);
    await putHighlight({
      ...highlight("deleted-citation", deletedBook.id),
      noteId: note.id,
      citation: { level: "content" },
    });
    await putHighlight({
      ...highlight("kept-citation", keptBook.id),
      noteId: note.id,
      citation: { level: "content" },
    });

    await deleteBook(deletedBook.id);

    const [updated] = await getAllNotes();
    expect(updated.content).not.toContain(
      "shufang-citation-id:deleted%2Dcitation"
    );
    expect(updated.content).toContain("shufang-citation-id:kept%2Dcitation");
    expect(updated.content.match(/具体内容/g)).toHaveLength(1);
  });

  it("deletes a note whose only citations belong to the deleted book", async () => {
    const deletedBook = book("delete-note-owner");
    const note: Note = {
      id: "book-only-note",
      title: "Book-only note",
      content: citationBlock({
        level: "content",
        highlightId: "book-only-citation",
        bookTitle: deletedBook.title,
        chapterTitle: "Chapter",
        text: "Text",
      }),
      createdAt: 1,
      updatedAt: 1,
    };
    await putBook(deletedBook);
    await putNote(note);
    await putHighlight({
      ...highlight("book-only-citation", deletedBook.id),
      noteId: note.id,
      citation: { level: "content" },
    });

    await deleteBook(deletedBook.id);

    expect(await getAllNotes()).toEqual([]);
  });

  it("removes a highlight and its generated citation block together", async () => {
    const sourceBook = { ...book("citation-book"), title: "Source Book" };
    const note: Note = {
      id: "citation-note",
      title: "Citations",
      content: citationBlock({
        level: "content",
        highlightId: "citation-highlight",
        bookTitle: sourceBook.title,
        chapterTitle: "Chapter",
        text: "Text",
      }),
      createdAt: 1,
      updatedAt: 1,
    };
    await putBook(sourceBook);
    await putNote(note);
    await putHighlight({
      ...highlight("citation-highlight", sourceBook.id),
      noteId: note.id,
      citation: { level: "content" },
    });

    const result = await deleteHighlightsWithCitationCleanup([
      "citation-highlight",
    ]);

    expect(result.deletedHighlightIds).toEqual(["citation-highlight"]);
    expect(result.updatedNotes).toHaveLength(1);
    expect(await getHighlights()).toEqual([]);
    const [updatedNote] = await getAllNotes();
    expect(updatedNote.content).not.toContain("shufang-citation");
  });

  it("deletes citation-only highlights and unlinks enriched highlights with a note", async () => {
    const sourceBook = { ...book("note-book"), title: "Source Book" };
    const note: Note = {
      id: "delete-note",
      title: "Delete me",
      content: "Body",
      createdAt: 1,
      updatedAt: 1,
    };
    await putBook(sourceBook);
    await putNote(note);
    await putHighlight({
      ...highlight("citation-only", sourceBook.id),
      style: { kind: "none", color: "orange" },
      noteId: note.id,
      citation: { level: "content" },
    });
    await putHighlight({
      ...highlight("enriched", sourceBook.id),
      noteId: note.id,
      citation: { level: "content" },
      note: "Keep this annotation",
    });

    const result = await deleteNote(note.id);

    expect(result.deletedHighlightIds).toEqual(["citation-only"]);
    expect(result.unlinkedHighlights.map(item => item.id)).toEqual([
      "enriched",
    ]);
    expect(await getAllNotes()).toEqual([]);
    const remaining = await getHighlights();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      id: "enriched",
      note: "Keep this annotation",
    });
    expect(remaining[0].noteId).toBeUndefined();
    expect(remaining[0].citation).toBeUndefined();
  });
});
