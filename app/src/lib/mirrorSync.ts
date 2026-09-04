import type { BookMetadata, Chapter } from "@/types";
import { dispatchAppAuthRequired } from "./auth-events";

export const BACKEND_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MIRROR_REQUEST_BYTES = 512 * 1024;
export const MAX_MIRROR_UPLOAD_BYTES = 96 * 1024 * 1024;
export const MAX_MIRROR_UPLOAD_CHUNKS = 512;

const MIN_MIRROR_REQUEST_BYTES = 384;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface MirrorEventEnvelope {
  /** Stable across every retry of one logical delivery. */
  deliveryId?: string;
  type: string;
  data: Record<string, unknown>;
}

export interface MirrorDeliveryOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  maxAttempts?: number;
  retryDelayMs?: number | ((failedAttempt: number) => number);
  signal?: AbortSignal;
  /** Chunked book endpoints must explicitly confirm their durable write. */
  requireMirrored?: boolean;
  onRetry?: (attempt: number, error: MirrorSyncError) => void;
}

export class MirrorSyncError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { status?: number; retryable?: boolean }
  ) {
    super(message);
    this.name = "MirrorSyncError";
    this.status = options?.status;
    this.retryable = options?.retryable ?? false;
  }
}

function responseDetail(text: string): string {
  if (!text) return "";
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const detail = value.message ?? value.error;
    if (typeof detail === "string") return `：${detail.slice(0, 240)}`;
  } catch {
    // Plain-text error bodies are still useful to the caller.
  }
  return `：${text.slice(0, 240)}`;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function createMirrorDeliveryId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}

function waitForRetry(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Deliver one browser mirror event. Unlike fire-and-forget fetch, this rejects
 * non-2xx responses and `mirrored:false`, and retries transient failures.
 */
export async function deliverMirrorEvent(
  event: MirrorEventEnvelope,
  options: MirrorDeliveryOptions = {}
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("maxAttempts must be an integer between 1 and 10");
  }
  // Create this once, before the retry loop. A response can disappear after
  // the server commits, so every replay must carry the same idempotency key.
  const deliveryId = event.deliveryId ?? createMirrorDeliveryId();
  const body = JSON.stringify({ ...event, deliveryId });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl("/api/v1/events", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
        body,
        signal: options.signal,
      });
      if (response.status === 401) dispatchAppAuthRequired();
      const text = await response.text();
      if (!response.ok) {
        throw new MirrorSyncError(
          `镜像服务返回 HTTP ${response.status}${responseDetail(text)}`,
          {
            status: response.status,
            retryable: retryableStatus(response.status),
          }
        );
      }

      let result: Record<string, unknown> | null = null;
      try {
        result = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        throw new MirrorSyncError("镜像服务返回了无效 JSON", {
          status: response.status,
          retryable: true,
        });
      }
      if (result?.ok !== true) {
        throw new MirrorSyncError("镜像服务没有确认事件", {
          status: response.status,
          retryable: true,
        });
      }
      if (result.mirrored === false) {
        throw new MirrorSyncError("镜像数据库写入失败", {
          status: response.status,
          retryable: true,
        });
      }
      if (options.requireMirrored && result.mirrored !== true) {
        throw new MirrorSyncError("镜像服务没有确认持久化", {
          status: response.status,
          retryable: true,
        });
      }
      return;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const normalized =
        error instanceof MirrorSyncError
          ? error
          : new MirrorSyncError(
              `无法连接镜像服务：${
                error instanceof Error ? error.message : "未知错误"
              }`,
              { retryable: true }
            );
      if (!normalized.retryable || attempt === maxAttempts) throw normalized;
      options.onRetry?.(attempt + 1, normalized);
      const configuredDelay = options.retryDelayMs ?? 250;
      const delay =
        typeof configuredDelay === "function"
          ? configuredDelay(attempt)
          : configuredDelay * 2 ** (attempt - 1);
      await waitForRetry(delay, options.signal);
    }
  }
}

export interface BookMirrorSnapshot {
  extId: string;
  title: string;
  author: string;
  format: string;
  folder?: string;
  contentHash?: string;
  metadata?: BookMetadata;
  chapters: Pick<Chapter, "id" | "title" | "paragraphs">[];
}

export interface BookMirrorProtocol {
  uploadId: string;
  encodedBytes: number;
  chunks: MirrorEventEnvelope[];
  start: MirrorEventEnvelope;
  complete: MirrorEventEnvelope;
  metadataUpdate?: MirrorEventEnvelope;
}

function eventBytes(event: MirrorEventEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

function chunkEvent(
  snapshot: BookMirrorSnapshot,
  uploadId: string,
  index: number,
  chunkCount: number,
  payload: string,
  deliveryId = "00000000-0000-4000-8000-000000000000"
): MirrorEventEnvelope {
  return {
    deliveryId,
    type: "book.import.chunk",
    data: { extId: snapshot.extId, uploadId, index, chunkCount, payload },
  };
}

function splitChapterJson(
  snapshot: BookMirrorSnapshot,
  uploadId: string,
  chaptersJson: string,
  maxRequestBytes: number
): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < chaptersJson.length || chunks.length === 0) {
    let low = 1;
    let high = Math.max(1, chaptersJson.length - cursor);
    let accepted = 0;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const candidate = chaptersJson.slice(cursor, cursor + size);
      const bytes = eventBytes(
        chunkEvent(
          snapshot,
          uploadId,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          candidate
        )
      );
      if (bytes <= maxRequestBytes) {
        accepted = size;
        low = size + 1;
      } else {
        high = size - 1;
      }
    }
    if (accepted === 0) {
      throw new MirrorSyncError("镜像分块上限过小，无法容纳事件元数据");
    }
    const boundary = cursor + accepted;
    if (
      boundary < chaptersJson.length &&
      accepted > 0 &&
      chaptersJson.charCodeAt(boundary - 1) >= 0xd800 &&
      chaptersJson.charCodeAt(boundary - 1) <= 0xdbff &&
      chaptersJson.charCodeAt(boundary) >= 0xdc00 &&
      chaptersJson.charCodeAt(boundary) <= 0xdfff
    ) {
      // Never persist a lone UTF-16 surrogate in an individual MySQL row.
      // mysql2 encodes lone surrogates as replacement characters, which would
      // corrupt the joined JSON and make completion fail for emoji/CJK Ext-B.
      accepted -= 1;
    }
    if (accepted === 0) {
      throw new MirrorSyncError("镜像分块上限无法容纳一个完整字符");
    }
    chunks.push(chaptersJson.slice(cursor, cursor + accepted));
    cursor += accepted;
  }
  return chunks;
}

function assertProtocolEventSize(
  event: MirrorEventEnvelope,
  maxRequestBytes: number
): void {
  if (eventBytes(event) > maxRequestBytes) {
    throw new MirrorSyncError("镜像事件超过客户端请求上限");
  }
}

/**
 * Build the resumable book-upload protocol without creating a >50 MiB body.
 * The server stages chunks by `(extId, uploadId, index)` and only replaces the
 * live book after `book.import.completed` verifies every chunk and parses the
 * concatenated JSON. Re-sending start/chunk/complete must be idempotent.
 */
export function createBookMirrorProtocol(
  snapshot: BookMirrorSnapshot,
  options: { uploadId?: string; maxRequestBytes?: number } = {}
): BookMirrorProtocol {
  const maxRequestBytes = Math.min(
    options.maxRequestBytes ?? DEFAULT_MIRROR_REQUEST_BYTES,
    BACKEND_BODY_LIMIT_BYTES
  );
  if (maxRequestBytes < MIN_MIRROR_REQUEST_BYTES) {
    throw new MirrorSyncError(
      `镜像请求上限不能低于 ${MIN_MIRROR_REQUEST_BYTES} 字节`
    );
  }
  const uploadId =
    options.uploadId ??
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const chaptersJson = JSON.stringify(snapshot.chapters);
  const encodedBytes = new TextEncoder().encode(chaptersJson).byteLength;
  if (encodedBytes > MAX_MIRROR_UPLOAD_BYTES) {
    throw new MirrorSyncError("书籍镜像超过 96 MiB 总上传上限");
  }
  const payloads = splitChapterJson(
    snapshot,
    uploadId,
    chaptersJson,
    maxRequestBytes
  );
  if (payloads.length > MAX_MIRROR_UPLOAD_CHUNKS) {
    throw new MirrorSyncError(
      `书籍镜像分块不能超过 ${MAX_MIRROR_UPLOAD_CHUNKS} 个`
    );
  }
  const chunks = payloads.map((payload, index) =>
    chunkEvent(
      snapshot,
      uploadId,
      index,
      payloads.length,
      payload,
      createMirrorDeliveryId()
    )
  );
  const common = {
    extId: snapshot.extId,
    uploadId,
    chunkCount: chunks.length,
    encodedBytes,
  };
  const start: MirrorEventEnvelope = {
    deliveryId: createMirrorDeliveryId(),
    type: "book.import.started",
    data: {
      ...common,
      title: snapshot.title,
      author: snapshot.author,
      format: snapshot.format,
      folder: snapshot.folder ?? "",
      contentHash: snapshot.contentHash ?? "",
      chapterCount: snapshot.chapters.length,
    },
  };
  const complete: MirrorEventEnvelope = {
    deliveryId: createMirrorDeliveryId(),
    type: "book.import.completed",
    data: common,
  };
  const metadataUpdate = snapshot.metadata
    ? {
        deliveryId: createMirrorDeliveryId(),
        type: "book.updated",
        data: {
          extId: snapshot.extId,
          title: snapshot.title,
          author: snapshot.author,
          metadata: snapshot.metadata,
        },
      }
    : undefined;
  assertProtocolEventSize(start, maxRequestBytes);
  assertProtocolEventSize(complete, maxRequestBytes);
  if (metadataUpdate) assertProtocolEventSize(metadataUpdate, maxRequestBytes);
  for (const chunk of chunks) assertProtocolEventSize(chunk, maxRequestBytes);
  return { uploadId, encodedBytes, chunks, start, complete, metadataUpdate };
}

export type BookMirrorPhase =
  "preparing" | "uploading" | "retrying" | "completed" | "failed";

export interface BookMirrorProgress {
  phase: BookMirrorPhase;
  sentChunks: number;
  totalChunks: number;
  attempt?: number;
  error?: MirrorSyncError;
}

/** Map protocol progress into the final two percent of the import tray. */
export function mirrorImportTrayProgress(progress: BookMirrorProgress): {
  stage: string;
  ratio: number;
} {
  const completedRatio =
    progress.totalChunks > 0 ? progress.sentChunks / progress.totalChunks : 0;
  const stage =
    progress.phase === "retrying"
      ? `镜像同步重试（第 ${progress.attempt ?? 2} 次）`
      : progress.phase === "uploading"
        ? `同步镜像 ${progress.sentChunks}/${progress.totalChunks}`
        : progress.phase === "completed"
          ? "镜像同步完成"
          : "准备同步镜像";
  return {
    stage,
    ratio: 0.98 + Math.min(1, completedRatio) * 0.019,
  };
}

export interface BookMirrorSyncOptions extends MirrorDeliveryOptions {
  uploadId?: string;
  maxRequestBytes?: number;
  onProgress?: (progress: BookMirrorProgress) => void;
}

/** Upload a complete book mirror sequentially and report every retry/failure. */
export async function syncBookMirror(
  snapshot: BookMirrorSnapshot,
  options: BookMirrorSyncOptions = {}
): Promise<void> {
  let protocol: BookMirrorProtocol;
  try {
    options.onProgress?.({ phase: "preparing", sentChunks: 0, totalChunks: 0 });
    protocol = createBookMirrorProtocol(snapshot, options);
  } catch (error) {
    const normalized =
      error instanceof MirrorSyncError
        ? error
        : new MirrorSyncError(
            error instanceof Error ? error.message : "无法准备镜像上传"
          );
    options.onProgress?.({
      phase: "failed",
      sentChunks: 0,
      totalChunks: 0,
      error: normalized,
    });
    throw normalized;
  }

  let sentChunks = 0;
  const deliver = (event: MirrorEventEnvelope) =>
    deliverMirrorEvent(event, {
      ...options,
      requireMirrored: true,
      onRetry: (attempt, error) => {
        options.onRetry?.(attempt, error);
        options.onProgress?.({
          phase: "retrying",
          sentChunks,
          totalChunks: protocol.chunks.length,
          attempt,
          error,
        });
      },
    });

  try {
    await deliver(protocol.start);
    options.onProgress?.({
      phase: "uploading",
      sentChunks,
      totalChunks: protocol.chunks.length,
    });
    for (const chunk of protocol.chunks) {
      await deliver(chunk);
      sentChunks++;
      options.onProgress?.({
        phase: "uploading",
        sentChunks,
        totalChunks: protocol.chunks.length,
      });
    }
    await deliver(protocol.complete);
    if (protocol.metadataUpdate) await deliver(protocol.metadataUpdate);
    options.onProgress?.({
      phase: "completed",
      sentChunks,
      totalChunks: protocol.chunks.length,
    });
  } catch (error) {
    const normalized =
      error instanceof MirrorSyncError
        ? error
        : new MirrorSyncError(
            error instanceof Error ? error.message : "镜像上传失败"
          );
    options.onProgress?.({
      phase: "failed",
      sentChunks,
      totalChunks: protocol.chunks.length,
      error: normalized,
    });
    throw normalized;
  }
}
