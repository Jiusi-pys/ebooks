import { describe, expect, it } from "vitest";
import { AI_PROVIDERS, DEFAULT_AI_CONFIG } from "./aiConfig";

describe("AI defaults", () => {
  it("uses DeepSeek by default and does not offer Codex in the reader UI", () => {
    expect(DEFAULT_AI_CONFIG.provider).toBe("deepseek");
    expect(Object.keys(AI_PROVIDERS)).toEqual(["deepseek"]);
  });
});
