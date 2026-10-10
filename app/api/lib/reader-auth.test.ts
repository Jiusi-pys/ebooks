import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
import { requireReaderOrMachine } from "./reader-auth";

const guards = vi.hoisted(() => ({
  browserRead: vi.fn(),
  browserWrite: vi.fn(),
  machine: vi.fn(),
}));
vi.mock("../auth", () => ({
  requireBrowserSession: (...args: unknown[]) => guards.browserRead(...args),
  requireBrowserMutation: (...args: unknown[]) => guards.browserWrite(...args),
}));
vi.mock("./openapi-auth", () => ({
  requireApiKey: (...args: unknown[]) => guards.machine(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  guards.browserRead.mockImplementation((_c, next) => next());
  guards.browserWrite.mockImplementation((_c, next) => next());
  guards.machine.mockImplementation((_c, next) => next());
});

function router() {
  const app = new Hono();
  app.use("*", requireReaderOrMachine);
  app.get("/books", c => c.json({ ok: true }));
  app.post("/notes", c => c.json({ ok: true }));
  app.get("/api/v1/webhooks", c => c.json({ ok: true }));
  return app;
}

it("uses account sessions for native reads and writes", async () => {
  const app = router();
  expect(
    (
      await app.request("/books", {
        headers: { Cookie: "shufang_session=signed" },
      })
    ).status
  ).toBe(200);
  expect(
    (
      await app.request("/notes", {
        method: "POST",
        headers: {
          Cookie: "shufang_session=signed",
          Origin: "https://reader.test",
        },
      })
    ).status
  ).toBe(200);
  expect(guards.browserRead).toHaveBeenCalledTimes(1);
  expect(guards.browserWrite).toHaveBeenCalledTimes(1);
  expect(guards.machine).not.toHaveBeenCalled();
});

it("keeps webhook administration machine-only", async () => {
  guards.machine.mockImplementationOnce(c =>
    c.json({ error: "unauthorized" }, 401)
  );
  const app = router();
  const denied = await app.request("/api/v1/webhooks", {
    headers: { Cookie: "shufang_session=signed" },
  });
  expect(denied.status).toBe(401);
  expect(guards.browserRead).not.toHaveBeenCalled();
  const allowed = await app.request("/api/v1/webhooks", {
    headers: { "X-API-Key": "peer" },
  });
  expect(allowed.status).toBe(200);
});

it("keeps machine keys separate and never falls back to a cookie after an invalid key", async () => {
  guards.machine.mockImplementationOnce(c =>
    c.json({ error: "unauthorized" }, 401)
  );
  const app = router();
  const denied = await app.request("/books", {
    headers: {
      "X-API-Key": "wrong",
      Cookie: "shufang_session=signed",
    },
  });
  expect(denied.status).toBe(401);
  expect(guards.browserRead).not.toHaveBeenCalled();
  const allowed = await app.request("/books", {
    headers: { "X-API-Key": "peer" },
  });
  expect(allowed.status).toBe(200);
  expect(guards.machine).toHaveBeenCalledTimes(2);
});

it("does not treat an empty machine credential as an account session", async () => {
  const app = router();
  await app.request("/books", {
    headers: { "X-API-Key": "", Cookie: "shufang_session=signed" },
  });
  expect(guards.machine).toHaveBeenCalledTimes(1);
  expect(guards.browserRead).not.toHaveBeenCalled();
});
