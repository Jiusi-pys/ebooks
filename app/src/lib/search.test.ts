import { describe, expect, it } from "vitest";
import type { Book, Highlight, Note, StudySet } from "@/types";
import { searchLibrary, type SearchData } from "./search";

const books: Book[] = ["a", "b", "c"].map(id => ({
  id,
  title: `书 ${id}`,
  author: "作者",
  format: "txt",
  coverTone: 0,
  createdAt: 1,
  folderId: "same-folder",
  chapters: [
    {
      id: `${id}-ch`,
      title: "章节",
      paragraphs: ["前言", "测试 Hello [.*] 后文"],
    },
  ],
  progress: { chapterId: `${id}-ch`, ratio: 0 },
}));
const notes: Note[] = ["linked", "standalone"].map(id => ({
  id,
  title: id,
  content: "测试笔记",
  createdAt: 1,
  updatedAt: 1,
}));
const highlights: Highlight[] = [
  {
    id: "h",
    bookId: "a",
    chapterId: "a-ch",
    chapterTitle: "章节",
    text: "Hello",
    note: "测试批注",
    noteId: "linked",
    createdAt: 1,
    paraIndex: 1,
    start: 3,
    end: 8,
  },
];
const studySets: StudySet[] = [
  {
    id: "set",
    name: "合集",
    bookIds: ["a", "b", "deleted"],
    createdAt: 1,
    updatedAt: 1,
  },
];
const data: SearchData = { books, notes, highlights, studySets };

describe("global library search", () => {
  it("locates note matches after hidden citation metadata without changing offsets", async () => {
    const content = "<!-- hidden -->正文测试";
    const result = await searchLibrary(
      { ...data, notes: [{ ...notes[0], content }] },
      "测试",
      { scope: "all" }
    );
    expect(
      result.results.find(r => r.kind === "笔记")?.route.searchNoteRange
    ).toEqual({
      field: "content",
      start: content.indexOf("测试"),
      end: content.length,
    });
    expect(
      (
        await searchLibrary(
          { ...data, notes: [{ ...notes[0], content }] },
          "hidden",
          { scope: "all" }
        )
      ).results
    ).toEqual([]);
  });
  it("limits a study set by membership, never the shelf folder", async () => {
    const result = await searchLibrary(data, "测试", {
      scope: "studySet",
      studySetId: "set",
    });
    expect(
      result.results.filter(r => r.kind === "正文").map(r => r.route.bookId)
    ).toEqual(["a", "b"]);
    expect(
      result.results.filter(r => r.kind === "笔记").map(r => r.route.noteId)
    ).toEqual(["linked"]);
  });
  it("includes standalone notes only in the whole library", async () => {
    const all = await searchLibrary(data, "测试", { scope: "all" });
    expect(all.results.filter(r => r.kind === "笔记")).toHaveLength(2);
    const one = await searchLibrary(data, "测试", {
      scope: "book",
      bookId: "b",
    });
    expect(one.results).toHaveLength(1);
    expect(one.results[0].route.bookId).toBe("b");
  });
  it("does not fall back to all books for missing context or blank queries", async () => {
    for (const context of [
      { scope: "book" },
      { scope: "studySet", studySetId: "missing" },
    ] as const) {
      expect((await searchLibrary(data, "测试", context)).results).toEqual([]);
    }
    expect((await searchLibrary(data, "  ", { scope: "all" })).results).toEqual(
      []
    );
  });
  it("matches literal input case insensitively and builds exact paragraph anchors", async () => {
    const result = await searchLibrary(data, " hELLo ", {
      scope: "book",
      bookId: "b",
    });
    expect(result.results[0].route.passageAnchor).toMatchObject({
      kind: "text",
      bookId: "b",
      chapterId: "b-ch",
      paraIndex: 1,
      start: 3,
      end: 8,
      text: "Hello",
    });
    expect(result.results[0].route.outlineParaIndex).not.toBe(0);
    expect(
      (await searchLibrary(data, "[.*]", { scope: "all" })).results
    ).toHaveLength(3);
  });
  it("searches metadata, chapter titles and annotation names and comments", async () => {
    expect(
      (await searchLibrary(data, "作者", { scope: "all" })).results
    ).toHaveLength(3);
    expect(
      (await searchLibrary(data, "章节", { scope: "book", bookId: "b" }))
        .results[0].route.chapterId
    ).toBe("b-ch");
    const result = await searchLibrary(data, "批注", { scope: "all" });
    expect(result.results[0].route.highlightId).toBe("h");
  });
  it("caps results explicitly and supports cancellation", async () => {
    const result = await searchLibrary(
      data,
      "测试",
      { scope: "all" },
      { limit: 2 }
    );
    expect(result.results).toHaveLength(2);
    expect(result.truncated).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchLibrary(
        data,
        "测试",
        { scope: "all" },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("searches original PDFs page by page and preserves page anchors", async () => {
    const pdf: Book = {
      ...books[0],
      format: "pdf",
      chapters: [],
      readerMode: "original",
    };
    const result = await searchLibrary(
      { ...data, books: [pdf], notes: [], highlights: [] },
      "测试",
      { scope: "all" },
      {
        pdfPages: async function* () {
          yield { page: 7, text: "PDF 测试正文" };
        },
      }
    );
    expect(result.results[0].route.passageAnchor).toMatchObject({
      kind: "pdf",
      pdfAnchor: { page: 7, rects: [] },
    });
    expect(result.warnings).toEqual([]);
  });
  it("reports missing PDF text and extraction failures without hiding other hits", async () => {
    const pdf: Book = { ...books[0], format: "pdf", chapters: [] };
    const input = { ...data, books: [pdf, books[1]] };
    for (const pdfPages of [
      async function* () {
        yield { page: 1, text: "" };
      },
      async function* () {
        throw new Error("missing file");
        yield { page: 1, text: "" };
      },
    ]) {
      const result = await searchLibrary(
        input,
        "测试",
        { scope: "all" },
        { pdfPages }
      );
      expect(result.warnings).toHaveLength(1);
      expect(result.results.some(r => r.route.bookId === "b")).toBe(true);
    }
  });
});
