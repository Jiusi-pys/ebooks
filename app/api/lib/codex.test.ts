import { describe, expect, it } from "vitest";
import { buildCodexPrompt } from "./codex";

describe("buildCodexPrompt", () => {
  it("preserves roles and disables workspace actions", () => {
    const prompt = buildCodexPrompt([
      { role: "system", content: "只输出译文" },
      { role: "user", content: "Hello" },
    ]);
    expect(prompt).toContain("不要访问文件、运行命令");
    expect(prompt).toContain("<system>\n只输出译文\n</system>");
    expect(prompt).toContain("<user>\nHello\n</user>");
  });
});
