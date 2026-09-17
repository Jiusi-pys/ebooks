import { describe, expect, it, vi } from "vitest";
import { library } from "./library";

vi.mock("./auth", () => ({
  requireBrowserSession: (_c: unknown, next: () => Promise<void>) => next(),
  requireBrowserMutation: (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("./queries/connection", () => ({
  getDb: () => {
    throw new Error("database unavailable");
  },
}));

describe("library database outage", () => {
  it("returns a retryable error instead of an empty successful library", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await library.request("/books");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: "library_unavailable",
      });
    } finally {
      log.mockRestore();
    }
  });
});
