import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SyncStore } from "./store";
import type { BlobStore } from "./blobs";

const events = vi.hoisted(() => [] as unknown[]);
vi.mock("../lib/webhooks", () => ({
  fanout: (event: unknown) => events.push(event),
}));

afterEach(() => {
  events.length = 0;
  vi.unstubAllEnvs();
});

it("fans out a newly persisted legacy bridge mutation once", async () => {
  vi.stubEnv("OPEN_API_KEY", "test-key");
  vi.resetModules();
  const { legacyBridge } = await import("./legacy");
  let duplicate = false;
  const store = {
    workspace: "w",
    nodeId: "r",
    operation: async () => undefined,
    head: async () => ({ clock: "0:0" }),
    mutate: async () => ({ operationId: "op", duplicate }),
  } as unknown as SyncStore;
  const api = new Hono();
  api.route("/api/v1", legacyBridge(store, {} as BlobStore));
  const request = () =>
    api.request("http://localhost/api/v1/notes", {
      method: "POST",
      headers: {
        "X-API-Key": "test-key",
        "Content-Type": "application/json",
        "Idempotency-Key": "op",
      },
      body: JSON.stringify({
        extId: "note-one",
        title: "Test",
        content: "Body",
      }),
    });
  const first = await request();
  expect(first.status).toBe(200);
  expect(events).toMatchObject([
    { type: "note.created", data: { extId: "note-one" } },
  ]);
  duplicate = true;
  expect((await request()).status).toBe(200);
  expect(events).toHaveLength(1);
});
