import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  started: [] as Record<string, unknown>[],
  chunks: [] as Record<string, unknown>[],
  completed: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  failCompletion: false,
}));

vi.mock("./queries/connection", () => ({
  getDb: () => ({}),
}));

vi.mock("./lib/openapi-auth", () => ({
  requireApiKey: async (
    _context: unknown,
    next: () => Promise<void>
  ): Promise<void> => next(),
}));

vi.mock("./lib/webhooks", () => ({
  EVENT_TYPES: ["book.imported"],
  fanout: (event: Record<string, unknown>) => state.events.push(event),
}));

vi.mock("./lib/codex", () => ({
  askCodex: vi.fn(),
  codexAuthController: {
    status: vi.fn(),
    startLogin: vi.fn(),
    logout: vi.fn(),
  },
}));

vi.mock("./lib/book-mirror-upload", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./lib/book-mirror-upload")>();
  return {
    ...actual,
    startBookMirrorUpload: async (data: Record<string, unknown>) => {
      state.started.push(data);
    },
    putBookMirrorChunk: async (data: Record<string, unknown>) => {
      state.chunks.push(data);
    },
    completeBookMirrorUpload: async (data: Record<string, unknown>) => {
      state.completed.push(data);
      if (state.failCompletion) {
        throw new actual.BookMirrorUploadError(
          "upload_incomplete",
          "missing chunk"
        );
      }
      return {
        extId: "book-1",
        title: "Large book",
        author: "Author",
        format: "txt",
        folder: "",
        contentHash: "hash",
        chapterCount: 1,
        alreadyCompleted: state.completed.length > 1,
      };
    },
  };
});

import { v1 } from "./v1";

function eventRequest(
  type: string,
  data: Record<string, unknown>
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "test",
    },
    body: JSON.stringify({ type, data }),
  };
}

const manifest = {
  extId: "book-1",
  uploadId: "upload-1",
  chunkCount: 1,
  encodedBytes: 64,
};

describe("v1 chunked book mirror events", () => {
  beforeEach(() => {
    state.started = [];
    state.chunks = [];
    state.completed = [];
    state.events = [];
    state.failCompletion = false;
  });

  it("persists start and chunk events without forwarding staging payloads", async () => {
    const startResponse = await v1.request(
      "/events",
      eventRequest("book.import.started", {
        ...manifest,
        title: "Large book",
        author: "Author",
        format: "txt",
        chapterCount: 1,
      })
    );
    const chunkResponse = await v1.request(
      "/events",
      eventRequest("book.import.chunk", {
        extId: manifest.extId,
        uploadId: manifest.uploadId,
        index: 0,
        chunkCount: 1,
        payload: "[]",
      })
    );

    expect(await startResponse.json()).toMatchObject({
      ok: true,
      mirrored: true,
    });
    expect(await chunkResponse.json()).toMatchObject({
      ok: true,
      mirrored: true,
    });
    expect(state.started).toHaveLength(1);
    expect(state.chunks).toHaveLength(1);
    expect(state.events).toEqual([]);
  });

  it("forwards one metadata-only book.imported event after completion", async () => {
    const response = await v1.request(
      "/events",
      eventRequest("book.import.completed", manifest)
    );

    expect(await response.json()).toMatchObject({ ok: true, mirrored: true });
    expect(state.events).toEqual([
      {
        type: "book.imported",
        source: "reader",
        data: {
          extId: "book-1",
          title: "Large book",
          author: "Author",
          format: "txt",
          folder: "",
          contentHash: "hash",
          chapterCount: 1,
        },
      },
    ]);
  });

  it("acknowledges a repeated completion without duplicate fanout", async () => {
    const first = await v1.request(
      "/events",
      eventRequest("book.import.completed", manifest)
    );
    const repeated = await v1.request(
      "/events",
      eventRequest("book.import.completed", manifest)
    );

    expect(await first.json()).toMatchObject({ ok: true, mirrored: true });
    expect(await repeated.json()).toMatchObject({ ok: true, mirrored: true });
    expect(state.completed).toHaveLength(2);
    expect(state.events).toHaveLength(1);
  });

  it("returns a retryable error and does not fan out incomplete uploads", async () => {
    state.failCompletion = true;
    const response = await v1.request(
      "/events",
      eventRequest("book.import.completed", manifest)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      mirrored: false,
      error: "upload_incomplete",
    });
    expect(state.events).toEqual([]);
  });
});
