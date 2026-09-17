import { describe, expect, it } from "vitest";
import { library } from "./library";

describe("browser library authentication", () => {
  it.each([
    ["GET", "/books"],
    ["GET", "/books/test"],
    ["GET", "/books/test/source"],
    ["PATCH", "/books/test/state"],
    ["PUT", "/books/test/source/chunks"],
    ["POST", "/books/test/source/complete"],
  ])("requires a browser session for %s %s", async (method, path) => {
    const response = await library.request(path, { method });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
