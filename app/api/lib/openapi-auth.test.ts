import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredApiKey } from "./openapi-auth";

describe("machine API key authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("accepts only the configured API key", async () => {
    vi.stubEnv("OPEN_API_KEY", "machine-secret");
    vi.resetModules();
    const { validKey } = await import("./openapi-auth");
    expect(validKey("machine-secret")).toBe(true);
    expect(validKey("machine-secrex")).toBe(false);
    expect(validKey("short")).toBe(false);
  });

  it("falls back to APP_SECRET when OPEN_API_KEY is blank", () => {
    expect(
      resolveConfiguredApiKey({
        OPEN_API_KEY: "   ",
        APP_SECRET: " fallback-secret ",
      })
    ).toBe("fallback-secret");
    expect(
      resolveConfiguredApiKey({
        OPEN_API_KEY: "machine-secret",
        APP_SECRET: "fallback-secret",
      })
    ).toBe("machine-secret");
    expect(resolveConfiguredApiKey({})).toBe("");
  });

  it("uses APP_SECRET in the real validator when the dedicated key is empty", async () => {
    vi.stubEnv("OPEN_API_KEY", "");
    vi.stubEnv("APP_SECRET", "fallback-secret");
    vi.resetModules();
    const { validKey } = await import("./openapi-auth");
    expect(validKey("fallback-secret")).toBe(true);
    expect(validKey("")).toBe(false);
  });
});
