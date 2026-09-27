import { describe, expect, it, vi } from "vitest";
import { createAutoStartApi } from "./auto-start";

vi.mock("./auth", () => ({
  requireBrowserSession: async (_context: unknown, next: () => Promise<void>) =>
    next(),
  requireBrowserMutation: async (
    _context: unknown,
    next: () => Promise<void>
  ) => next(),
}));

describe("automatic startup API", () => {
  it("returns current startup state", async () => {
    const manager = {
      status: vi.fn(async () => ({
        supported: true,
        installed: true,
        enabled: false,
        platform: "linux" as const,
      })),
      setEnabled: vi.fn(),
    };
    const api = createAutoStartApi(manager);

    const response = await api.request("/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      installed: true,
      enabled: false,
    });
  });

  it("validates the requested state and updates the task", async () => {
    const manager = {
      status: vi.fn(),
      setEnabled: vi.fn(async enabled => ({
        supported: true,
        installed: true,
        enabled,
        platform: "windows" as const,
      })),
    };
    const api = createAutoStartApi(manager);

    const bad = await api.request("/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(bad.status).toBe(400);
    expect(manager.setEnabled).not.toHaveBeenCalled();

    const good = await api.request("/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(good.status).toBe(200);
    expect(manager.setEnabled).toHaveBeenCalledWith(true);
    expect(await good.json()).toMatchObject({ enabled: true });
  });
});
