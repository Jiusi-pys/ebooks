import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Book } from "@/types";
import { BookCover } from "./BookCover";

const book: Book = {
  id: "book",
  title: "这是一本名称非常非常长的书籍",
  author: "",
  format: "txt",
  coverTone: 0,
  chapters: [],
  createdAt: 1,
  progress: { chapterId: "", ratio: 0 },
};

describe("BookCover", () => {
  it("clips a long vertical title inside the cover label", () => {
    const html = renderToStaticMarkup(createElement(BookCover, { book }));

    expect(html).toContain("max-h-[82%]");
    expect(html).toContain("overflow-hidden");
  });
});
