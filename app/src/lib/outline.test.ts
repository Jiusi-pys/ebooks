import { describe, expect, it } from "vitest";
import type { Book, OutlineItem } from "@/types";
import {
  addOutlineTarget,
  changeOutlineDepth,
  getBookOutline,
  isUserOutlineItem,
  moveOutlineItem,
  outlineTitle,
  removeOutlineItem,
  removeUserOutlineItem,
} from "./outline";

const items: OutlineItem[] = [
  { id: "a", title: "A", chapterId: "ca", depth: 0 },
  { id: "a1", title: "A1", chapterId: "ca", paraIndex: 2, depth: 1 },
  { id: "b", title: "B", chapterId: "cb", depth: 0 },
];

const book: Book = {
  id: "book",
  title: "Book",
  author: "Author",
  format: "builtin",
  coverTone: 0,
  chapters: [
    { id: "ca", title: "A", paragraphs: [] },
    { id: "cb", title: "B", paragraphs: [] },
  ],
  createdAt: 1,
  progress: { chapterId: "ca", ratio: 0 },
};

describe("editable outline", () => {
  it("moves a parent together with its children", () => {
    expect(moveOutlineItem(items, "a", 1).map(item => item.id)).toEqual([
      "b",
      "a",
      "a1",
    ]);
  });

  it("indents and outdents a subtree", () => {
    const indented = changeOutlineDepth(items, "b", 1);
    expect(indented[2].depth).toBe(1);
    expect(changeOutlineDepth(indented, "b", -1)[2].depth).toBe(0);
  });

  it("promotes children when removing a parent", () => {
    expect(removeOutlineItem(items, "a")).toEqual([
      { id: "a1", title: "A1", chapterId: "ca", paraIndex: 2, depth: 0 },
      items[2],
    ]);
  });

  it("adds a paragraph target below its chapter", () => {
    const next = addOutlineTarget(items, {
      id: "a2",
      title: "A2",
      chapterId: "ca",
      paraIndex: 4,
    });
    expect(next.map(item => item.id)).toEqual(["a", "a1", "a2", "b"]);
    expect(next[2].depth).toBe(1);
  });

  it("normalizes and truncates selected text", () => {
    expect(outlineTitle("  one\n two ", 6)).toBe("one tw…");
  });

  it("distinguishes imported chapters from reader-created entries", () => {
    const [chapter] = getBookOutline(book);
    expect(isUserOutlineItem(book, chapter)).toBe(false);
    expect(
      isUserOutlineItem(book, {
        id: "outline:custom",
        title: "Custom",
        depth: 0,
      })
    ).toBe(true);
  });

  it("never removes an imported chapter entry", () => {
    const outline = getBookOutline(book);
    expect(removeUserOutlineItem(book, outline, "chapter:ca")).toBe(outline);
  });

  it("removes a custom parent while preserving child jump anchors", () => {
    const outline: OutlineItem[] = [
      { id: "chapter:ca", title: "A", chapterId: "ca", depth: 0 },
      { id: "outline:group", title: "Group", depth: 1 },
      {
        id: "outline:anchor",
        title: "Anchor",
        chapterId: "cb",
        paraIndex: 7,
        depth: 2,
      },
      { id: "chapter:cb", title: "B", chapterId: "cb", depth: 0 },
    ];

    expect(removeUserOutlineItem(book, outline, "outline:group")).toEqual([
      outline[0],
      { ...outline[2], depth: 1 },
      outline[3],
    ]);
  });

  it("removes a custom navigation target without touching book chapters", () => {
    const outline: OutlineItem[] = [
      { id: "chapter:ca", title: "A", chapterId: "ca", depth: 0 },
      {
        id: "outline:anchor",
        title: "Anchor",
        chapterId: "ca",
        paraIndex: 3,
        depth: 1,
      },
      { id: "chapter:cb", title: "B", chapterId: "cb", depth: 0 },
    ];

    expect(
      removeUserOutlineItem(book, outline, "outline:anchor").map(
        item => item.id
      )
    ).toEqual(["chapter:ca", "chapter:cb"]);
  });
});
