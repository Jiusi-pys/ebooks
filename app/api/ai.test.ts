import { describe, expect, it } from "vitest";
import { parseStudyCard } from "./ai";

describe("parseStudyCard", () => {
  it("keeps only cloze phrases that exist in the source", () => {
    const card = parseStudyCard(
      '{"title":"核心概念","note":"解释","cloze":["原子卡片","不存在"],"tags":["知识管理"]}',
      "原子卡片让同一知识在多个视图复用。"
    );
    expect(card.cloze).toEqual(["原子卡片"]);
    expect(card.tags).toEqual(["知识管理"]);
  });

  it("falls back safely when the model does not return JSON", () => {
    const card = parseStudyCard("plain answer", "一段原文");
    expect(card.title).toBe("一段原文");
    expect(card.cloze).toEqual([]);
  });
});
