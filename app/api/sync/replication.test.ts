import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replication } from "./replication";
import { BlobStore, chunkSize } from "./blobs";
import { SyncStore, digest } from "./store";
import { makeOperation } from "../../contracts/sync";
import type { IncomingSnapshot } from "./snapshots";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sync-rest-"));
  dirs.push(dir);
  const checkpoints = new Map<string, string>();
  const localOp = makeOperation("w", "windows", "notes", "local", {
    title: "local",
  });
  const remoteOp = makeOperation("w", "linux", "notes", "remote", {
    title: "remote",
  });
  const store = {
    workspace: "w",
    nodeId: "windows",
    peerCursor: vi.fn(async (key: string) => checkpoints.get(key)),
    savePeerCursor: vi.fn(async (key: string, value: string) => {
      checkpoints.set(key, value);
    }),
    changes: vi.fn(async (cursor?: string) => ({
      operations: cursor ? [] : [localOp],
      cursor: "local-1",
      hasMore: false,
    })),
    accept: vi.fn(async () => ({ seq: "1" })),
    entities: vi.fn(async () => ({ entities: [] as unknown[], next: null })),
  };
  const local = new BlobStore(join(dir, "local")),
    remote = new BlobStore(join(dir, "remote"));
  const pushes: string[][] = [];
  let epoch = "remote-1",
    dropAck = false,
    partial = false,
    failChunk = -1;
  const chunks: number[] = [];
  const staged = new Map<string, IncomingSnapshot>();
  const ages = new Map<string, number>();
  let snapshotCreates = 0,
    dropSnapshot = false,
    zeroReceipt = false;
  const snapshots = {
    pending: async (key: string) => staged.get(key),
    age: async (key: string) => ages.get(key) ?? 0,
    begin: async (key: string, remote: { id: string; cursor: string }) => {
      staged.set(key, {
        version: 1,
        snapshotId: remote.id,
        cursor: remote.cursor,
        after: "",
        pages: 0,
        expectedCursor: checkpoints.get(key) ?? null,
      });
    },
    stage: async (
      key: string,
      _expected: { after: string; pages: number },
      page: { next: string | null }
    ) => {
      const pending = staged.get(key)!;
      staged.set(key, {
        ...pending,
        pages: pending.pages + 1,
        after: page.next,
      });
    },
    finish: async (key: string, now: number) => {
      checkpoints.set(key, staged.get(key)!.cursor);
      staged.delete(key);
      ages.set(key, now);
    },
    abandon: async (key: string) => {
      staged.delete(key);
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const u = new URL(input);
      expect(u.origin).toBe("https://sync.example");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer scoped-token"
      );
      expect(new Headers(init.headers).get("X-Workspace-Id")).toBe("w");
      const path = u.pathname.replace("/api/v2", "");
      const json = (x: unknown, status = 200) =>
        new Response(JSON.stringify(x), { status });
      if (path === "/capabilities")
        return json({ version: 2, workspaceId: "w", nodeId: "linux", epoch });
      if (path === "/sync/snapshots") {
        snapshotCreates++;
        return json({ id: "snapshot", cursor: "snapshot-watermark" });
      }
      if (path === "/sync/snapshots/snapshot") {
        if (u.searchParams.get("after") === "next" && dropSnapshot) {
          dropSnapshot = false;
          throw new Error("snapshot disconnected");
        }
        return json({
          cursor: "snapshot-watermark",
          entities: [],
          next: u.searchParams.get("after") ? null : "next",
        });
      }
      if (path === "/sync/push") {
        const body = JSON.parse(String(init.body));
        pushes.push(
          body.operations.map((o: { operationId: string }) => o.operationId)
        );
        if (dropAck) {
          dropAck = false;
          throw new Error("lost acknowledgement");
        }
        return json({
          receipts: body.operations.map((o: { operationId: string }) => ({
            operationId: o.operationId,
            ...(partial
              ? { persisted: false, error: "failure" }
              : { seq: zeroReceipt ? "0" : "1", duplicate: pushes.length > 1 }),
          })),
        });
      }
      if (path === "/sync/changes")
        return json({
          operations: u.searchParams.has("cursor") ? [] : [remoteOp],
          cursor: "remote-cursor",
          hasMore: false,
        });
      if (path === "/blobs/uploads")
        return json(await remote.create(JSON.parse(String(init.body))), 201);
      const match = path.match(/^\/blobs\/uploads\/([^/]+)(?:\/(.+))?$/);
      if (match) {
        const [, id, part] = match;
        try {
          if (!part) return json(await remote.status(id));
          if (part === "commit") return json(await remote.commit(id));
          const index = Number(part);
          chunks.push(index);
          if (index === failChunk) {
            failChunk = -1;
            return json({ error: "offline" }, 503);
          }
          await remote.put(
            id,
            index,
            Buffer.from(init.body as Uint8Array),
            new Headers(init.headers).get("X-Chunk-SHA256")!
          );
          return json({ ok: true });
        } catch {
          return json({ error: "missing session" }, 404);
        }
      }
      throw new Error("Unexpected request " + path);
    })
  );
  const worker = () =>
    replication(
      store as unknown as SyncStore,
      local,
      [{ id: "linux", url: "https://sync.example", token: "scoped-token" }],
      snapshots
    );
  return {
    store,
    local,
    remote,
    localOp,
    remoteOp,
    pushes,
    chunks,
    checkpoints,
    worker,
    setEpoch: (s: string) => (epoch = s),
    loseAck: () => (dropAck = true),
    rejectReceipt: () => (partial = true),
    failChunk: (n: number) => (failChunk = n),
    disconnectSnapshot: () => {
      dropSnapshot = true;
    },
    snapshotCreates: () => snapshotCreates,
    staged,
    zeroReceipt: (value: boolean) => {
      zeroReceipt = value;
    },
  };
}
describe("outbound HTTPS bidirectional replication", () => {
  it("resumes an interrupted snapshot across worker restart", async () => {
    const f = await fixture();
    f.disconnectSnapshot();
    await f.worker().tick();
    expect(f.snapshotCreates()).toBe(1);
    expect([...f.staged.values()]).toMatchObject([{ after: "next", pages: 1 }]);
    expect(f.store.accept).not.toHaveBeenCalled();
    await f.worker().tick();
    expect(f.snapshotCreates()).toBe(1);
    expect(f.staged.size).toBe(0);
    expect(f.store.accept).toHaveBeenCalledWith(f.remoteOp);
  });
  it("rejects zero sequence receipts without advancing the send cursor", async () => {
    const f = await fixture();
    f.zeroReceipt(true);
    await f.worker().tick();
    f.zeroReceipt(false);
    await f.worker().tick();
    expect(f.pushes).toEqual([
      [f.localOp.operationId],
      [f.localOp.operationId],
    ]);
  });
  it("pushes local changes and pulls remote changes from one outbound connection", async () => {
    const f = await fixture();
    await f.worker().tick();
    expect(f.pushes).toEqual([[f.localOp.operationId]]);
    expect(f.store.accept).toHaveBeenCalledWith(f.remoteOp);
    await f.worker().tick();
    expect(f.pushes).toHaveLength(1);
  });
  it("retries the same operation after lost acknowledgement across worker restart", async () => {
    const f = await fixture();
    f.loseAck();
    await f.worker().tick();
    await f.worker().tick();
    expect(f.pushes).toEqual([
      [f.localOp.operationId],
      [f.localOp.operationId],
    ]);
  });
  it("does not advance the outgoing cursor on per-item failure", async () => {
    const f = await fixture();
    f.rejectReceipt();
    await f.worker().tick();
    await f.worker().tick();
    expect(f.pushes).toHaveLength(2);
  });
  it("replays outgoing operations when the remote epoch changes", async () => {
    const f = await fixture();
    await f.worker().tick();
    f.setEpoch("remote-2");
    await f.worker().tick();
    expect(f.pushes).toHaveLength(2);
  });
  it("splits outgoing batches within the complete 1 MiB JSON request limit", async () => {
    const f = await fixture();
    const operations = ["one", "two"].map(id =>
      makeOperation("w", "windows", "notes", id, {
        content: "x".repeat(600_000),
      })
    );
    f.store.changes.mockResolvedValue({
      operations,
      cursor: "local-2",
      hasMore: false,
    });
    await f.worker().tick();
    expect(f.pushes).toEqual(operations.map(op => [op.operationId]));
  });
  it("uploads local file chunks and resumes after interruption with durable session state", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(chunkSize + 31, 7);
    const manifest = {
      sha256: digest(bytes),
      size: bytes.length,
      name: "book.epub",
      type: "application/epub+zip",
    };
    const upload = await f.local.create(manifest);
    for (let i = 0; i < upload.chunks; i++) {
      const b = bytes.subarray(i * chunkSize, (i + 1) * chunkSize);
      await f.local.put(upload.id, i, b, digest(b));
    }
    await f.local.commit(upload.id);
    f.store.entities.mockResolvedValue({
      entities: [
        {
          id: "b",
          kind: "sources",
          deleted: false,
          fields: Object.fromEntries(
            Object.entries(manifest).map(([k, value]) => [
              k,
              { value, version: "v" },
            ])
          ),
        },
      ],
      next: null,
    });
    f.failChunk(1);
    await f.worker().tick();
    await f.worker().tick();
    expect(await readFile(f.remote.path(manifest.sha256))).toEqual(bytes);
    expect(f.chunks).toEqual([0, 1, 1]);
  });
});
