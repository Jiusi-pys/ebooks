import { describe, expect, it } from "vitest";
import {
  DEFAULT_TYPE,
  loadTypeSettings,
  normalizePageMargin,
  planReaderChapterEntry,
  readerPagePadding,
  saveTypeSettings,
} from "./reading";

describe("reader page margin", () => {
  it("upgrades settings saved before pageMargin existed", () => {
    const storage = {
      getItem: () => JSON.stringify({ fontSize: 22, columns: 2 }),
    };

    expect(loadTypeSettings(storage)).toMatchObject({
      fontSize: 22,
      columns: 2,
      pageMargin: DEFAULT_TYPE.pageMargin,
    });
  });

  it("clamps invalid or out-of-range persisted margins", () => {
    expect(normalizePageMargin(Number.NaN)).toBe(DEFAULT_TYPE.pageMargin);
    expect(normalizePageMargin(4)).toBe(16);
    expect(normalizePageMargin(120)).toBe(96);
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

    expect(JSON.parse(values.get("shufang-type2") ?? "{}").pageMargin).toBe(96);
  });

  it("produces responsive padding for narrow split panes", () => {
    expect(readerPagePadding(48)).toBe("clamp(16px, 48px, 12%)");
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
