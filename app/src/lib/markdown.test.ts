import { describe, expect, it } from "vitest";
import { plainExcerpt } from "./markdown";

describe("plainExcerpt", () => {
  it("preserves the existing Markdown preview behavior", () => {
    expect(plainExcerpt("# 标题\n**重点** 参见 [[另一条笔记]]")).toBe(
      "标题 重点 参见 另一条笔记"
    );
    expect(plainExcerpt("abcdef", 4)).toBe("abcd…");
  });
});
