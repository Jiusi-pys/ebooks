import { describe, expect, it } from "vitest";
import { AI_PROVIDERS, DEFAULT_AI_CONFIG } from "./aiConfig";

describe("AI defaults", () => {
  it("uses DeepSeek by default and exposes providers with live model endpoints", () => {
    expect(DEFAULT_AI_CONFIG.provider).toBe("deepseek");
    expect(Object.keys(AI_PROVIDERS)).toEqual([
      "deepseek",
      "openai",
      "kimi",
      "minimax",
    ]);
    expect(AI_PROVIDERS.openai.label).toContain("OpenAI");
    expect(AI_PROVIDERS.kimi.label).toContain("Kimi");
    expect(AI_PROVIDERS.minimax.label).toContain("MiniMax");
  });
});
