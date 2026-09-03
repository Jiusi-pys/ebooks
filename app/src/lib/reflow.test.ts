import { describe, expect, it } from "vitest";
import { joinBrokenLines, normalizeParagraph } from "./reflow";

describe("reflow Unicode boundaries", () => {
  it("joins CJK without a space and Latin text with a space", () => {
    expect(joinBrokenLines("中文", "段落")).toBe("中文段落");
    expect(joinBrokenLines("hello", "world")).toBe("hello world");
    expect(joinBrokenLines("hyphen-", "ated")).toBe("hyphenated");
  });

  it("normalizes whitespace and adds Latin/CJK separation", () => {
    expect(normalizeParagraph("  GPT书籍\t管理  ")).toBe("GPT 书籍 管理");
  });
});
