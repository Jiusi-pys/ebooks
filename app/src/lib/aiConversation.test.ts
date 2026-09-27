import { describe, expect, it } from "vitest";
import { conversationHistory } from "./aiConversation";

describe("passage conversation context", () => {
  it("keeps prior questions and answers in conversational order", () => {
    expect(
      conversationHistory([
        { q: "这个概念？", a: "是自由", ts: 1 },
        { q: "举个例子", a: "自由选择职业", ts: 2 },
      ])
    ).toEqual([
      { role: "user", content: "这个概念？" },
      { role: "assistant", content: "是自由" },
      { role: "user", content: "举个例子" },
      { role: "assistant", content: "自由选择职业" },
    ]);
  });
  it("bounds recent context without mutating saved answers", () => {
    const qa = Array.from({ length: 30 }, (_, i) => ({
      q: `q${i}`,
      a: "a".repeat(8000),
      ts: i,
    }));
    const history = conversationHistory(qa);
    expect(history.length).toBeLessThanOrEqual(20);
    expect(
      history.reduce((n, m) => n + m.content.length, 0)
    ).toBeLessThanOrEqual(24000);
    expect(history.at(-2)?.content).toBe("q29");
    expect(qa[29].a.length).toBe(8000);
  });
});
