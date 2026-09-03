import { describe, expect, it } from "vitest";
import type { Book, StudySet } from "@/types";
import { getSplitBooks } from "./splitScope";

const book = (id: string, folderId?: string): Book => ({
  id,
  title: id,
  author: "",
  format: "builtin",
  coverTone: 0,
  chapters: [],
  createdAt: 0,
  progress: { chapterId: "", ratio: 0 },
  folderId,
});

const books = [
  book("a", "folder-1"),
  book("b", "folder-2"),
  book("c", "folder-1"),
];
const studySet: StudySet = {
  id: "set-1",
  name: "跨文件夹主题",
  bookIds: ["a", "b"],
  createdAt: 0,
  updatedAt: 0,
};

describe("split book scope", () => {
  it("offers the full library outside a study set", () => {
    expect(getSplitBooks(books, books[0]).map(item => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("uses explicit study-set membership and ignores folders", () => {
    expect(
      getSplitBooks(books, books[0], studySet).map(item => item.id)
    ).toEqual(["a", "b"]);
  });

  it("keeps the current book available for stale study-set routes", () => {
    expect(
      getSplitBooks(books, books[2], studySet).map(item => item.id)
    ).toEqual(["c", "a", "b"]);
  });
});
