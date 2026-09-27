import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  DEFAULT_AI_CONFIG,
  loadAiConfig,
  readProviderApiKey,
  saveAiConfig,
} from "./aiConfig";

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

  it("persists provider keys across browser sessions and removes cleared keys", () => {
    const originalWindow = globalThis.window;
    const storage = new Map<string, string>();
    const persistent = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    const sessionValues = new Map<string, string>();
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => sessionValues.set(key, value),
      removeItem: (key: string) => sessionValues.delete(key),
    };
    Object.defineProperty(globalThis, "window", {
      value: { dispatchEvent: () => true },
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: persistent,
      configurable: true,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      value: session,
      configurable: true,
    });
    try {
      saveAiConfig({
        provider: "openai",
        model: "gpt-4.1",
        effort: "none",
        apiKey: "sk-persistent-test",
      });

      expect(storage.get("shufang:ai-api-key:openai")).toBe(
        "sk-persistent-test"
      );
      expect(readProviderApiKey("openai")).toBe("sk-persistent-test");
      expect(storage.get("shufang:ai-config:v1")).not.toContain(
        "sk-persistent-test"
      );

      saveAiConfig({
        provider: "openai",
        model: "gpt-4.1",
        effort: "none",
      });
      expect(storage.has("shufang:ai-api-key:openai")).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
      });
      Reflect.deleteProperty(globalThis, "localStorage");
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });

  it("migrates an existing session key into persistent browser storage", () => {
    const originalWindow = globalThis.window;
    const persistentValues = new Map<string, string>();
    const sessionValues = new Map<string, string>([
      ["shufang:ai-api-key:deepseek", "sk-session-test"],
    ]);
    const persistent = {
      getItem: (key: string) => persistentValues.get(key) ?? null,
      setItem: (key: string, value: string) =>
        persistentValues.set(key, value),
      removeItem: (key: string) => persistentValues.delete(key),
    };
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => sessionValues.set(key, value),
      removeItem: (key: string) => sessionValues.delete(key),
    };
    Object.defineProperty(globalThis, "window", {
      value: { dispatchEvent: () => true },
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: persistent,
      configurable: true,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      value: session,
      configurable: true,
    });
    try {
      expect(loadAiConfig().apiKey).toBe("sk-session-test");
      expect(persistentValues.get("shufang:ai-api-key:deepseek")).toBe(
        "sk-session-test"
      );
      expect(sessionValues.has("shufang:ai-api-key:deepseek")).toBe(false);
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
