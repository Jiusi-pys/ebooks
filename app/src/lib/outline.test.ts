import { describe, expect, it } from "vitest";
import type { OutlineItem } from "@/types";
import {
  addOutlineTarget,
  changeOutlineDepth,
  moveOutlineItem,
  outlineTitle,
  removeOutlineItem,
} from "./outline";

const items: OutlineItem[] = [
  { id: "a", title: "A", chapterId: "ca", depth: 0 },
  { id: "a1", title: "A1", chapterId: "ca", paraIndex: 2, depth: 1 },
  { id: "b", title: "B", chapterId: "cb", depth: 0 },
];

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
});
