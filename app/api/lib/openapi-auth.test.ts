import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
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

  it("never reuses APP_SECRET when OPEN_API_KEY is blank", () => {
    expect(
      resolveConfiguredApiKey({
        OPEN_API_KEY: "   ",
        APP_SECRET: " fallback-secret ",
      })
    ).toBe("");
    expect(
      resolveConfiguredApiKey({
        OPEN_API_KEY: "machine-secret",
        APP_SECRET: "fallback-secret",
      })
    ).toBe("machine-secret");
    expect(resolveConfiguredApiKey({})).toBe("");
  });

  it("disables machine routes when the dedicated key is empty", async () => {
    vi.stubEnv("OPEN_API_KEY", "");
    vi.stubEnv("APP_SECRET", "fallback-secret");
    vi.resetModules();
    const { requireApiKey, validKey } = await import("./openapi-auth");
    const router = new Hono();
    router.use("/*", requireApiKey);
    router.get("/books", c => c.json({ ok: true }));
    const response = await router.request("http://reader.test/books", {
      headers: { "x-api-key": "fallback-secret" },
    });
    expect(validKey("fallback-secret")).toBe(false);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "machine_api_unavailable",
    });
  });
});
