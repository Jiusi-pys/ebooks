import { describe, expect, it, vi } from "vitest";
import { APP_AUTH_REQUIRED_EVENT } from "./auth-events";

import {
  createBookMirrorProtocol,
  deliverMirrorEvent,
  mirrorImportTrayProgress,
  MirrorSyncError,
  syncBookMirror,
  type BookMirrorSnapshot,
} from "./mirrorSync";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function snapshot(paragraphs = ["正文"]): BookMirrorSnapshot {
  return {
    extId: "book-1",
    title: "分块测试",
    author: "作者",
    format: "epub",
    chapters: [{ id: "chapter-1", title: "第一章", paragraphs }],
  };
}

describe("deliverMirrorEvent", () => {
  it("retries a transient non-2xx response and confirms persistence", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: "busy" }, 503))
      .mockResolvedValueOnce(response({ ok: true, mirrored: true }));
    const onRetry = vi.fn();

    await deliverMirrorEvent(
      { type: "book.import.completed", data: { extId: "book-1" } },
      { fetchImpl, retryDelayMs: 0, requireMirrored: true, onRetry }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    const firstBody = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body)
    ) as { deliveryId: string };
    const secondBody = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body)
    ) as { deliveryId: string };
    expect(firstBody.deliveryId).toMatch(/^[A-Za-z0-9._:-]{16,64}$/);
    expect(secondBody.deliveryId).toBe(firstBody.deliveryId);
  });

  it("surfaces HTTP 413 without retrying", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "too_large" }, 413));

    await expect(
      deliverMirrorEvent(
        { type: "book.imported", data: { extId: "book-1" } },
        { fetchImpl, retryDelayMs: 0 }
      )
    ).rejects.toMatchObject({ status: 413, retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("notifies the session owner when the REST endpoint returns 401", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "unauthorized" }, 401));

    try {
      await expect(
        deliverMirrorEvent(
          { type: "highlight.created", data: { id: "highlight-1" } },
          { fetchImpl }
        )
      ).rejects.toMatchObject({ status: 401, retryable: false });
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
        type: APP_AUTH_REQUIRED_EVENT,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats a 200 mirrored:false response as a failed write", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ok: true, mirrored: false }));

    await expect(
      deliverMirrorEvent(
        { type: "book.imported", data: { extId: "book-1" } },
        { fetchImpl, maxAttempts: 1 }
      )
    ).rejects.toThrow("镜像数据库写入失败");
  });
});

describe("book mirror chunk protocol", () => {
  it("maps upload and retry state into an observable import-tray status", () => {
    const uploading = mirrorImportTrayProgress({
      phase: "uploading",
      sentChunks: 2,
      totalChunks: 4,
    });
    expect(uploading.stage).toBe("同步镜像 2/4");
    expect(uploading.ratio).toBeCloseTo(0.9895);
    expect(
      mirrorImportTrayProgress({
        phase: "retrying",
        sentChunks: 2,
        totalChunks: 4,
        attempt: 3,
      })
    ).toMatchObject({ stage: "镜像同步重试（第 3 次）" });
  });

  it("keeps every request bounded and reconstructs the exact chapter JSON", () => {
    const book = snapshot([
      "A".repeat(900),
      '含有引号、换行与 emoji："x"\n🙂'.repeat(30),
    ]);
    const protocol = createBookMirrorProtocol(book, {
      uploadId: "upload-1",
      maxRequestBytes: 600,
    });

    expect(protocol.chunks.length).toBeGreaterThan(2);
    const events = [protocol.start, ...protocol.chunks, protocol.complete];
    for (const event of events) {
      expect(
        new TextEncoder().encode(JSON.stringify(event)).byteLength
      ).toBeLessThanOrEqual(600);
    }
    expect(
      protocol.chunks.map(chunk => String(chunk.data.payload)).join("")
    ).toBe(JSON.stringify(book.chapters));
    expect(protocol.start.data).toMatchObject({
      chunkCount: protocol.chunks.length,
      chapterCount: 1,
    });
  });

  it("never splits a supplementary Unicode character across database chunks", () => {
    const book = snapshot(["🙂𠀀".repeat(300)]);
    for (let maxRequestBytes = 384; maxRequestBytes <= 720; maxRequestBytes++) {
      const protocol = createBookMirrorProtocol(book, {
        uploadId: "unicode-boundary",
        maxRequestBytes,
      });
      for (const chunk of protocol.chunks) {
        const payload = String(chunk.data.payload);
        const first = payload.charCodeAt(0);
        const last = payload.charCodeAt(payload.length - 1);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
      expect(
        protocol.chunks.map(chunk => String(chunk.data.payload)).join("")
      ).toBe(JSON.stringify(book.chapters));
    }
  });

  it("reports retries, progress and a terminal completion", async () => {
    const phases: string[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: "busy" }, 503))
      .mockImplementation(async () => response({ ok: true, mirrored: true }));

    await syncBookMirror(snapshot(), {
      uploadId: "upload-2",
      maxRequestBytes: 600,
      fetchImpl,
      retryDelayMs: 0,
      onProgress: progress => phases.push(progress.phase),
    });

    expect(phases[0]).toBe("preparing");
    expect(phases).toContain("retrying");
    expect(phases.at(-1)).toBe("completed");
  });

  it("reports a terminal non-retryable failure", async () => {
    const progress = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "unauthorized" }, 401));

    await expect(
      syncBookMirror(snapshot(), {
        uploadId: "upload-3",
        maxRequestBytes: 600,
        fetchImpl,
        onProgress: progress,
      })
    ).rejects.toBeInstanceOf(MirrorSyncError);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed" })
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
