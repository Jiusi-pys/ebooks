import { describe, expect, it } from "vitest";
import {
  MAIN_READER_PANE,
  closeReferencePane,
  countReaderPanes,
  routeForSplitTarget,
  splitTargetFromRoute,
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

  it("keeps each pane's route and jump anchors independent from the main reader", () => {
    const mainRoute = {
      view: "reader" as const,
      bookId: "main-book",
      chapterId: "main-chapter",
      highlightId: "main-highlight",
      outlineParaIndex: 8,
    };
    const target = {
      bookId: "pane-book",
      chapterId: "pane-chapter",
      route: { studySetId: "set-1", highlightId: "pane-highlight" },
    };

    expect(routeForSplitTarget(mainRoute, target)).toMatchObject({
      view: "reader",
      bookId: "pane-book",
      chapterId: "pane-chapter",
      studySetId: "set-1",
      highlightId: "pane-highlight",
      outlineParaIndex: undefined,
    });
    expect(
      splitTargetFromRoute(
        {
          view: "reader",
          bookId: "pane-book",
          chapterId: "next-chapter",
          studySetId: "set-1",
          highlightId: "selected-highlight",
        },
        "fallback"
      )
    ).toEqual({
      bookId: "pane-book",
      chapterId: "next-chapter",
      route: {
        studySetId: "set-1",
        highlightId: "selected-highlight",
        anchorText: undefined,
        passageAnchor: undefined,
        outlineParaIndex: undefined,
        outlineNavigationKey: undefined,
      },
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

  it("lets the main pane split repeatedly and caps the workspace at four panes", () => {
    const two = splitReaderPane(
      MAIN_READER_PANE,
      "main",
      "horizontal",
      target,
      "r1",
      "s1"
    );
    const three = splitReaderPane(two, "r1", "vertical", target, "r2", "s2");
    const four = splitReaderPane(three, "main", "vertical", target, "r3", "s3");
    expect(countReaderPanes(four)).toBe(4);
    expect(four).toMatchObject({
      first: { kind: "split", direction: "vertical", first: { kind: "main" } },
    });
    expect(splitReaderPane(four, "r2", "horizontal", target, "r4", "s4")).toBe(
      four
    );
  });
});
