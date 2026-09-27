import { describe, expect, it } from "vitest";
import { AI_PROVIDERS, DEFAULT_AI_CONFIG, loadAiConfig } from "./aiConfig";

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

  it("restores a usable DeepSeek model from older empty-model settings", () => {
    const originalWindow = globalThis.window;
    const storage = new Map<string, string>([
      [
        "shufang:ai-config:v1",
        JSON.stringify({ provider: "deepseek", model: "", effort: "none" }),
      ],
    ]);
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: (key: string) => storage.get(key) ?? null },
      configurable: true,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      value: { getItem: () => null },
      configurable: true,
    });
    try {
      expect(loadAiConfig().model).toBe("deepseek-flash");
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
      });
      Reflect.deleteProperty(globalThis, "localStorage");
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});
