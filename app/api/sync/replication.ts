import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { z } from "zod";

const uploadProgress = z.object({
  manifest: blobManifest,
  missing: z.array(z.number().int().nonnegative()).max(1024),
});
import {
  type Operation,
  materialize,
  isBlobReference,
  operationSchema,
} from "../../contracts/sync";
import { BlobStore, blobManifest, type BlobManifest, chunkSize } from "./blobs";
import { SyncStore, SyncError, digest } from "./store";
import { IncomingSnapshots } from "./snapshots";
import { sharedCore } from "../../contracts/core-runtime";
import { readPeerBytes, readPeerJson } from "./peer-response";

export interface Peer {
  id: string;
  url: string;
  token: string;
}
export function replication(
  store: SyncStore,
  blobs: BlobStore,
  peers: Peer[],
  snapshots: Pick<
    IncomingSnapshots,
    "pending" | "age" | "begin" | "stage" | "finish" | "abandon"
  > = new IncomingSnapshots(store)
) {
  const confirmedUploads = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status: Record<
    string,
    { lastSuccess?: string; error?: string; failures: number }
  > = {};
  async function request(peer: Peer, path: string, init: RequestInit = {}) {
    const response = await fetch(
      `${peer.url.replace(/\/$/, "")}/api/v2${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${peer.token}`,
          "X-Workspace-Id": store.workspace,
        },
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      }
    );
    if (!response.ok) {
      throw new SyncError(
        `peer ${peer.id}: HTTP ${response.status}`,
        response.status
      );
    }
    return response;
  }
  const jsonPost = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const requestJson = async (peer: Peer, path: string, init?: RequestInit) =>
    readPeerJson(await request(peer, path, init));
  // Hash compound keys to stay within sync_cursors.peer's 128-character limit.
  const checkpointKey = (type: string, peer: Peer, epoch: string, hash = "") =>
    `${type}:${digest(JSON.stringify([peer.id, peer.url, epoch, hash]))}`;
  async function push(peer: Peer, epoch: string) {
    const key = checkpointKey("push", peer, epoch);
    let more = true;
    for (let pages = 0; more && pages < 100 && !stopped; pages++) {
      const cursor = await store.peerCursor(key);
      let page;
      try {
        page = await store.changes(cursor || undefined);
      } catch (error) {
        if (error instanceof SyncError && error.status === 409)
          await store.savePeerCursor(key, "");
        throw error;
      }
      let batch: Operation[] = [];
      const send = async () => {
        if (!batch.length) return;
        const { receipts } = z
          .object({
            receipts: z
              .array(
                z.object({
                  operationId: z.string(),
                  seq: z.string().optional(),
                  persisted: z.boolean().optional(),
                  error: z.string().optional(),
                })
              )
              .max(100),
          })
          .parse(
            await requestJson(
              peer,
              "/sync/push",
              jsonPost({ operations: batch })
            )
          );
        sharedCore().execute("validateSyncReceipts", {
          operationIds: batch.map(op => op.operationId),
          receipts,
        });
        batch = [];
      };
      for (const op of page.operations) {
        if (
          Buffer.byteLength(JSON.stringify({ operations: [...batch, op] })) >
          1024 * 1024
        )
          await send();
        if (
          Buffer.byteLength(JSON.stringify({ operations: [op] })) >
          1024 * 1024
        )
          throw new Error("operation exceeds push request limit");
        batch.push(op);
      }
      await send();
      // A lost or partial receipt replays the page; operation IDs make that safe.
      await store.savePeerCursor(key, page.cursor);
      more = page.hasMore;
    }
  }
  async function upload(peer: Peer, epoch: string, manifest: BlobManifest) {
    const key = checkpointKey("upload", peer, epoch, manifest.sha256);
    if (confirmedUploads.has(key)) return;
    let id = await store.peerCursor(key);
    let progress: { manifest: BlobManifest; missing: number[] } | undefined;
    if (id) {
      try {
        progress = uploadProgress.parse(
          await requestJson(peer, `/blobs/uploads/${encodeURIComponent(id)}`)
        );
      } catch (error) {
        if (!(error instanceof SyncError) || error.status !== 404) throw error;
        id = undefined;
      }
    }
    if (!id) {
      const session = z
        .object({ id: z.string().regex(/^[a-f0-9-]{36}$/) })
        .parse(await requestJson(peer, "/blobs/uploads", jsonPost(manifest)));
      if (typeof session.id !== "string" || !/^[a-f0-9-]{36}$/.test(session.id))
        throw new Error("invalid peer upload session");
      id = session.id;
      await store.savePeerCursor(key, id!);
    }
    progress ??= uploadProgress.parse(
      await requestJson(peer, `/blobs/uploads/${id}`)
    );
    if (
      !progress ||
      progress.manifest.sha256 !== manifest.sha256 ||
      progress.manifest.size !== manifest.size ||
      !Array.isArray(progress.missing) ||
      progress.missing.length > 1024 ||
      progress.missing.some(
        i =>
          !Number.isInteger(i) ||
          i < 0 ||
          i >= Math.ceil(manifest.size / chunkSize)
      )
    )
      throw new Error("invalid peer upload progress");
    const file = await open(blobs.path(manifest.sha256), "r");
    try {
      for (const index of progress.missing) {
        const bytes = Buffer.alloc(
          Math.min(chunkSize, manifest.size - index * chunkSize)
        );
        const { bytesRead } = await file.read(
          bytes,
          0,
          bytes.length,
          index * chunkSize
        );
        if (bytesRead !== bytes.length)
          throw new Error("local blob size mismatch");
        await request(peer, `/blobs/uploads/${id}/${index}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Chunk-SHA256": digest(bytes),
          },
          body: new Uint8Array(bytes),
        });
      }
    } finally {
      await file.close();
    }
    const committed = blobManifest.parse(
      await requestJson(peer, `/blobs/uploads/${id}/commit`, { method: "POST" })
    );
    if (
      committed.sha256 !== manifest.sha256 ||
      committed.size !== manifest.size
    )
      throw new Error("invalid peer file acknowledgement");
    confirmedUploads.add(key);
  }
  async function transfer(peer: Peer, manifest: BlobManifest) {
    if (await blobs.has(manifest.sha256)) return;
    const key = `blob:${manifest.sha256}`;
    let id = await store.peerCursor(key);
    if (id) {
      try {
        await blobs.status(id);
      } catch {
        id = undefined;
      }
    }
    if (!id) {
      id = (await blobs.create(manifest)).id;
      await store.savePeerCursor(key, id);
    }
    const { missing } = await blobs.status(id);
    for (const index of missing) {
      const response = await request(
        peer,
        `/blobs/${manifest.sha256}/chunks/${index}`
      );
      const bytes = Buffer.from(await readPeerBytes(response, chunkSize));
      if (bytes.length > chunkSize) throw new Error("oversized_peer_chunk");
      await blobs.put(
        id,
        index,
        bytes,
        createHash("sha256").update(bytes).digest("hex")
      );
    }
    await blobs.commit(id);
  }
  async function restore(peer: Peer, epoch: string, force = false) {
    const key = checkpointKey("pull", peer, epoch);
    let pending = await snapshots.pending(key);
    if (
      !force &&
      !pending &&
      (await store.peerCursor(key)) &&
      Date.now() - (await snapshots.age(key)) < 300000
    )
      return;
    if (!pending) {
      const created = z
        .object({ id: z.string(), cursor: z.string() })
        .parse(await requestJson(peer, "/sync/snapshots", { method: "POST" }));
      await snapshots.begin(key, created, Date.now());
      pending = await snapshots.pending(key);
    }
    while (pending && !stopped) {
      if (pending.after === null) {
        await snapshots.finish(key, Date.now());
        return;
      }
      try {
        const page = z
          .object({
            cursor: z.string(),
            entities: z.array(z.unknown()).max(100),
            next: z.string().nullable(),
          })
          .parse(
            await requestJson(
              peer,
              `/sync/snapshots/${encodeURIComponent(pending.snapshotId)}?after=${encodeURIComponent(pending.after)}`
            )
          );
        await snapshots.stage(
          key,
          { after: pending.after, pages: pending.pages },
          page
        );
        pending = await snapshots.pending(key);
      } catch (error) {
        if (error instanceof SyncError && [404, 410].includes(error.status))
          await snapshots.abandon(key);
        throw error;
      }
    }
    throw new SyncError("snapshot_incomplete");
  }
  async function pull(peer: Peer, key: string) {
    for (let pages = 0; pages < 100 && !stopped; pages++) {
      const cursor = await store.peerCursor(key);
      const page = z
        .object({
          operations: z.array(operationSchema).max(100),
          cursor: z.string().min(1).max(4096),
          hasMore: z.boolean(),
        })
        .parse(
          await requestJson(
            peer,
            `/sync/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
          )
        );
      if (
        !Array.isArray(page.operations) ||
        page.operations.length > 100 ||
        typeof page.cursor !== "string" ||
        !page.cursor ||
        page.cursor.length > 4096 ||
        typeof page.hasMore !== "boolean" ||
        (page.hasMore && (!page.operations.length || page.cursor === cursor))
      )
        throw new SyncError("invalid_peer_page");
      for (const op of page.operations) await store.accept(op);
      await store.savePeerCursor(key, page.cursor);
      if (!page.hasMore) return;
    }
    throw new SyncError("sync_history_incomplete");
  }
  async function tick() {
    for (const peer of peers) {
      try {
        const capabilities = z
          .object({
            version: z.literal(2),
            workspaceId: z.string(),
            nodeId: z.string(),
            epoch: z.string().min(1).max(128),
          })
          .parse(await requestJson(peer, "/capabilities"));
        if (
          capabilities.version !== 2 ||
          capabilities.workspaceId !== store.workspace ||
          capabilities.nodeId !== peer.id ||
          typeof capabilities.epoch !== "string" ||
          !capabilities.epoch
        )
          throw new Error("peer identity or protocol mismatch");
        await push(peer, capabilities.epoch);
        await restore(peer, capabilities.epoch);
        const history = checkpointKey("history", peer, capabilities.epoch);
        const complete = checkpointKey(
          "history-complete",
          peer,
          capabilities.epoch
        );
        if (!(await store.peerCursor(complete))) {
          await pull(peer, history);
          await store.savePeerCursor(complete, "1");
        }
        const receive = checkpointKey("pull", peer, capabilities.epoch);
        try {
          await pull(peer, receive);
        } catch (error) {
          if (
            !(error instanceof SyncError) ||
            ![400, 409].includes(error.status)
          )
            throw error;
          await restore(peer, capabilities.epoch, true);
          await pull(peer, receive);
        }
        // Scan references separately: missing bytes must not hold up metadata or cursors.
        let after = "";
        const visited = new Set<string>();
        const fileErrors: string[] = [];
        const copy = async (input: unknown) => {
          const manifest = blobManifest.parse(input);
          if (visited.has(manifest.sha256)) return;
          visited.add(manifest.sha256);
          try {
            if (await blobs.has(manifest.sha256))
              await upload(peer, capabilities.epoch, manifest);
            else await transfer(peer, manifest);
          } catch (error) {
            fileErrors.push(
              error instanceof Error ? error.message : "file transfer failed"
            );
          }
        };
        do {
          const page = await store.entities(undefined, after);
          for (const state of page.entities) {
            const source = materialize(state);
            if (source && state.kind === "sources") await copy(source);
            if (source)
              for (const field of Object.values(state.fields))
                if (isBlobReference(field.value)) await copy(field.value.$blob);
          }
          after = page.entities.length === 100 ? (page.next ?? "") : "";
        } while (after && !stopped);
        status[peer.id] = {
          lastSuccess: new Date().toISOString(),
          failures: 0,
          ...(fileErrors.length
            ? {
                error: `${fileErrors.length} file(s) pending: ${fileErrors[0]}`,
              }
            : {}),
        };
      } catch (error) {
        const prev = status[peer.id];
        status[peer.id] = {
          ...prev,
          error: error instanceof Error ? error.message : "replication_failed",
          failures: (prev?.failures ?? 0) + 1,
        };
      }
    }
  }
  async function loop() {
    await tick();
    if (!stopped) {
      const failures = Math.min(
        ...Object.values(status).map(s => s.failures),
        6
      );
      timer = setTimeout(
        () => void loop(),
        Math.min(300_000, 5000 * 2 ** failures) + Math.random() * 500
      );
      timer.unref();
    }
  }
  return {
    status,
    tick,
    start() {
      void loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
