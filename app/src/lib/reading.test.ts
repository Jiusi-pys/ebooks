import { describe, expect, it } from "vitest";
import type { Book } from "@/types";
import {
  contentHashOfBook,
  clampSelectionToolbarLeft,
  DEFAULT_TYPE,
  horizontalReaderPageState,
  isPagedReaderMode,
  loadTypeSettings,
  normalizePageMargin,
  planReaderChapterEntry,
  readerPagePadding,
  readerScrollOffset,
  readerScrollRatio,
  saveTypeSettings,
} from "./reading";

const hashBook: Book = {
  id: "hash-book",
  title: "Editable title",
  author: "Editable author",
  format: "epub",
  coverTone: 0,
  chapters: [{ id: "c1", title: "Chapter", paragraphs: ["Body"] }],
  createdAt: 1,
  progress: { chapterId: "c1", ratio: 0 },
};

describe("book content hash", () => {
  it("ignores editable catalogue fields but changes with book contents", async () => {
    const original = await contentHashOfBook(hashBook);
    await expect(
      contentHashOfBook({
        ...hashBook,
        title: "Renamed",
        author: "Another author",
        metadata: { version: 1, publisher: "New publisher" },
      })
    ).resolves.toBe(original);
    await expect(
      contentHashOfBook({
        ...hashBook,
        chapters: [{ ...hashBook.chapters[0], paragraphs: ["Changed body"] }],
      })
    ).resolves.not.toBe(original);
  });
});

describe("reader page margin", () => {
  it("restores paragraph spacing and upgrades older preferences", () => {
    expect(loadTypeSettings({ getItem: () => "{}" })).toHaveProperty(
      "paragraphSpacing",
      0.4
    );
    const values = new Map<string, string>();
    saveTypeSettings(
      { ...DEFAULT_TYPE, paragraphSpacing: 1.5 },
      {
        setItem: (key, value) => values.set(key, value),
      }
    );
    expect(
      loadTypeSettings({ getItem: key => values.get(key) ?? null })
    ).toHaveProperty("paragraphSpacing", 1.5);
    expect(
      loadTypeSettings({ getItem: () => '{"paragraphSpacing":-1}' })
    ).toHaveProperty("paragraphSpacing", 0);
  });
  it("upgrades settings saved before pageMargin existed", () => {
    const storage = {
      getItem: () => JSON.stringify({ fontSize: 22, columns: 2 }),
    };

    expect(loadTypeSettings(storage)).toMatchObject({
      fontSize: 22,
      columns: 2,
      pageMargin: DEFAULT_TYPE.pageMargin,
      pageTurnMode: "vertical",
    });
  });

  it("rejects an unknown persisted page-turn mode", () => {
    const storage = {
      getItem: () => JSON.stringify({ pageTurnMode: "diagonal" }),
    };
    expect(loadTypeSettings(storage).pageTurnMode).toBe("vertical");
  });

  it("keeps the realistic page-turn mode when restoring preferences", () => {
    const storage = { getItem: () => JSON.stringify({ pageTurnMode: "curl" }) };
    expect(loadTypeSettings(storage).pageTurnMode).toBe("curl");
    expect(isPagedReaderMode("curl")).toBe(true);
    expect(isPagedReaderMode("vertical")).toBe(false);
  });

  it("clamps invalid or out-of-range persisted margins", () => {
    expect(normalizePageMargin(Number.NaN)).toBe(DEFAULT_TYPE.pageMargin);
    expect(normalizePageMargin(4)).toBe(16);
    expect(normalizePageMargin(320)).toBe(320);
    expect(normalizePageMargin(600)).toBe(480);
    expect(normalizePageMargin(47.6)).toBe(48);
  });

  it("falls back when stored JSON is malformed", () => {
    const storage = { getItem: () => "{" };
    expect(loadTypeSettings(storage)).toEqual(DEFAULT_TYPE);
  });

  it("persists the normalized setting under the existing preference key", () => {
    const values = new Map<string, string>();
    saveTypeSettings(
      { ...DEFAULT_TYPE, pageMargin: 200 },
      { setItem: (key, value) => values.set(key, value) }
    );

    expect(JSON.parse(values.get("shufang-type2") ?? "{}").pageMargin).toBe(
      200
    );
  });

  it("produces responsive padding for narrow split panes", () => {
    expect(readerPagePadding(48)).toBe("clamp(16px, 48px, 25%)");
    expect(readerPagePadding(480)).toBe("clamp(16px, 480px, 25%)");
  });
});

describe("reader page-turn metrics", () => {
  const metrics = {
    scrollTop: 300,
    scrollLeft: 800,
    scrollHeight: 1600,
    scrollWidth: 3200,
    clientHeight: 600,
    clientWidth: 800,
  };

  it("persists progress from the axis used by the selected mode", () => {
    expect(readerScrollRatio(metrics, "vertical")).toBe(0.3);
    expect(readerScrollRatio(metrics, "horizontal")).toBeCloseTo(1 / 3);
  });

  it("restores a ratio against the active layout dimensions", () => {
    expect(readerScrollOffset(metrics, "vertical", 0.5)).toBe(500);
    expect(readerScrollOffset(metrics, "horizontal", 0.5)).toBe(1200);
    expect(readerScrollOffset(metrics, "horizontal", 9)).toBe(2400);
  });

  it("reports horizontal screens and tolerates a partial final page", () => {
    expect(horizontalReaderPageState(metrics)).toEqual({
      page: 2,
      pageCount: 4,
      atStart: false,
      atEnd: false,
    });
    expect(
      horizontalReaderPageState({
        ...metrics,
        scrollLeft: 1570,
        scrollWidth: 2370,
      })
    ).toEqual({ page: 3, pageCount: 3, atStart: false, atEnd: true });
  });
});

describe("selection toolbar positioning", () => {
  it("keeps the toolbar fully inside the reading pane at both edges", () => {
    expect(clampSelectionToolbarLeft(20, 900)).toBe(164);
    expect(clampSelectionToolbarLeft(880, 900)).toBe(736);
    expect(clampSelectionToolbarLeft(450, 900)).toBe(450);
  });
});

describe("reader chapter entry", () => {
  it("restores the saved ratio when reopening the current chapter", () => {
    expect(
      planReaderChapterEntry(
        null,
        "chapter-2",
        { chapterId: "chapter-2", ratio: 0.62 },
        false
      )
    ).toEqual({ ratio: 0.62, persist: false });
  });

  it("resets and persists explicit initial chapter navigation", () => {
    expect(
      planReaderChapterEntry(
        null,
        "chapter-2",
        { chapterId: "chapter-2", ratio: 0.62 },
        true
      )
    ).toEqual({ ratio: 0, persist: true });
  });

  it("resets when an already open reader changes chapter", () => {
    expect(
      planReaderChapterEntry(
        "chapter-1",
        "chapter-2",
        { chapterId: "chapter-1", ratio: 0.9 },
        false
      )
    ).toEqual({ ratio: 0, persist: true });
  });
});
