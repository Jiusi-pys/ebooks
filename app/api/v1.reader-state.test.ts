import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const rows: { readerData: string | null }[] = [];
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { rows, limit, where, from, select };
});

vi.mock("./queries/connection", () => ({
  getDb: () => ({ select: db.select }),
}));

describe("GET /api/v1/books/:extId/state", () => {
  afterEach(() => {
    db.rows.splice(0);
    db.select.mockClear();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("requires the machine key and returns only synced reading fields", async () => {
    vi.stubEnv("OPEN_API_KEY", "mcp-test-key");
    db.rows.push({
      readerData: JSON.stringify({
        progress: { chapterId: "chapter-2", ratio: 0.63 },
        lastOpenedAt: 1_800_000_000_000,
        cover: "secret-cover-data",
        outline: [{ title: "private layout" }],
      }),
    });
    const { v1 } = await import("./v1");

    const unauthorized = await v1.request("/books/book-1/state");
    expect(unauthorized.status).toBe(401);

    const response = await v1.request("/books/book-1/state", {
      headers: { "X-API-Key": "mcp-test-key" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: {
        progress: { chapterId: "chapter-2", ratio: 0.63 },
        lastOpenedAt: 1_800_000_000_000,
      },
    });
  });

  it("returns 404 for a missing book", async () => {
    vi.stubEnv("OPEN_API_KEY", "mcp-test-key");
    const { v1 } = await import("./v1");
    const response = await v1.request("/books/missing/state", {
      headers: { "X-API-Key": "mcp-test-key" },
    });
    expect(response.status).toBe(404);
  });
});
