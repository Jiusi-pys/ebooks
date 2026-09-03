import { describe, expect, it } from "vitest";
import {
  MAIN_READER_PANE,
  closeReferencePane,
  countReaderPanes,
  splitReaderPane,
  updateReferencePane,
} from "./splitLayout";

const target = { bookId: "book-1", chapterId: "chapter-1" };

describe("reader split layout", () => {
  it("supports left-right followed by top-bottom", () => {
    const two = splitReaderPane(
      MAIN_READER_PANE,
      "main",
      "horizontal",
      target,
      "r1",
      "s1"
    );
    const three = splitReaderPane(two, "r1", "vertical", target, "r2", "s2");
    expect(countReaderPanes(three)).toBe(3);
    expect(three).toMatchObject({
      kind: "split",
      direction: "horizontal",
      second: { kind: "split", direction: "vertical" },
    });
  });

  it("supports top-bottom followed by left-right and collapses closed branches", () => {
    const two = splitReaderPane(
      MAIN_READER_PANE,
      "main",
      "vertical",
      target,
      "r1",
      "s1"
    );
    const three = splitReaderPane(two, "r1", "horizontal", target, "r2", "s2");
    const changed = updateReferencePane(three, "r2", {
      ...target,
      chapterId: "chapter-2",
    });
    expect(changed).toMatchObject({
      direction: "vertical",
      second: {
        direction: "horizontal",
        second: { target: { chapterId: "chapter-2" } },
      },
    });
    expect(countReaderPanes(closeReferencePane(changed, "r1"))).toBe(2);
  });

  it("caps the workspace at three panes", () => {
    const two = splitReaderPane(
      MAIN_READER_PANE,
      "main",
      "horizontal",
      target,
      "r1",
      "s1"
    );
    const three = splitReaderPane(two, "r1", "vertical", target, "r2", "s2");
    expect(splitReaderPane(three, "r2", "horizontal", target, "r3", "s3")).toBe(
      three
    );
  });
});
