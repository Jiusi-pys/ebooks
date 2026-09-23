import { describe, expect, it } from "vitest";
import {
  chunkChapterForTranslation,
  inferTargetLanguage,
  interpolateParagraphAnchor,
  paragraphAnchorAtProgress,
  paragraphAnchorProgress,
  splitTranslatedParagraphs,
} from "./bilingual";

describe("bilingual reader helpers", () => {
  it("defaults to English-to-Chinese or classical-to-modern translation", () => {
    expect(inferTargetLanguage(["这是中文章节。"])).toBe("现代汉语");
    expect(inferTargetLanguage(["An English chapter."])).toBe("中文");
  });

  it("preserves blank-line model paragraph boundaries", () => {
    expect(splitTranslatedParagraphs("第一段。\r\n\r\n第二段。", 2)).toEqual([
      "第一段。",
      "第二段。",
    ]);
  });

  it("accepts one-line-per-paragraph only when the count is exact", () => {
    expect(splitTranslatedParagraphs("one\ntwo\nthree", 3)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(splitTranslatedParagraphs("one\ntwo\nthree", 2)).toEqual([
      "one\ntwo\nthree",
    ]);
  });

  it("round-trips a paragraph anchor through chapter progress", () => {
    const progress = paragraphAnchorProgress({ index: 2, ratio: 0.5 }, 5);
    expect(progress).toBe(0.5);
    expect(paragraphAnchorAtProgress(progress, 5)).toEqual({
      index: 2,
      ratio: 0.5,
    });
  });

  it("chunks long chapters without exceeding the request budget", () => {
    const chunks = chunkChapterForTranslation(["12345", "67890", "x"], 10);
    expect(chunks).toEqual([
      { text: "12345", sourceParagraphCount: 1 },
      { text: "67890\n\nx", sourceParagraphCount: 2 },
    ]);
    expect(chunkChapterForTranslation(["abcdefghijkl"], 5)).toEqual([
      { text: "abcde", sourceParagraphCount: 1 },
      { text: "fghij", sourceParagraphCount: 1 },
      { text: "kl", sourceParagraphCount: 1 },
    ]);
    expect(
      chunkChapterForTranslation(["a".repeat(130_000)], 200_000).every(
        chunk => chunk.text.length <= 110_000
      )
    ).toBe(true);
  });

  it("interpolates when the model merges translation paragraphs", () => {
    expect(interpolateParagraphAnchor({ index: 2, ratio: 0.5 }, 5, 2)).toEqual({
      index: 1,
      ratio: 0,
    });
    expect(interpolateParagraphAnchor({ index: 4, ratio: 1 }, 5, 2)).toEqual({
      index: 1,
      ratio: 1,
    });
  });

  it("interpolates in both directions and clamps invalid boundaries", () => {
    expect(interpolateParagraphAnchor({ index: 1, ratio: 0 }, 2, 5)).toEqual({
      index: 2,
      ratio: 0.5,
    });
    expect(paragraphAnchorAtProgress(-4, 3)).toEqual({ index: 0, ratio: 0 });
    expect(paragraphAnchorAtProgress(4, 3)).toEqual({ index: 2, ratio: 1 });
    expect(interpolateParagraphAnchor({ index: 7, ratio: 7 }, 0, 3)).toEqual({
      index: 0,
      ratio: 0,
    });
  });
});
