import { createHash } from "node:crypto";
import {
  type Operation,
  materialize,
  isBlobReference,
} from "../../contracts/sync";
import { BlobStore, type BlobManifest, chunkSize } from "./blobs";
import { SyncStore } from "./store";

export interface Peer {
  id: string;
  url: string;
  token: string;
}
export function replication(store: SyncStore, blobs: BlobStore, peers: Peer[]) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status: Record<
    string,
    { lastSuccess?: string; error?: string; failures: number }
  > = {};
  async function request(peer: Peer, path: string) {
    const response = await fetch(
      `${peer.url.replace(/\/$/, "")}/api/v2${path}`,
      {
        headers: {
          Authorization: `Bearer ${peer.token}`,
          "X-Workspace-Id": store.workspace,
        },
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      }
    );
    if (!response.ok) {
      if (response.status === 409 && path.startsWith("/sync/changes"))
        await store.savePeerCursor(peer.id, "");
      throw new Error(`peer ${peer.id}: HTTP ${response.status}`);
    }
    return response;
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
      const bytes = Buffer.from(await response.arrayBuffer());
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
  async function tick() {
    for (const peer of peers) {
      try {
        let more = true;
        let pages = 0;
        while (more && pages++ < 100 && !stopped) {
          const cursor = await store.peerCursor(peer.id);
          const page = (await (
            await request(
              peer,
              `/sync/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
            )
          ).json()) as {
            operations: Operation[];
            cursor: string;
            hasMore: boolean;
          };
          if (!Array.isArray(page.operations) || page.operations.length > 100)
            throw new Error("invalid_peer_page");
          for (const op of page.operations) await store.accept(op);
          await store.savePeerCursor(peer.id, page.cursor);
          more = page.hasMore;
        }
        // Scan references separately: missing bytes must not hold up metadata or cursors.
        let after = "";
        do {
          const page = await store.entities(undefined, after);
          for (const state of page.entities) {
            const source = materialize(state);
            if (source && state.kind === "sources")
              await transfer(peer, source as unknown as BlobManifest);
            if (source)
              for (const field of Object.values(state.fields))
                if (isBlobReference(field.value))
                  await transfer(peer, field.value.$blob);
          }
          after = page.entities.length === 100 ? (page.next ?? "") : "";
        } while (after && !stopped);
        status[peer.id] = {
          lastSuccess: new Date().toISOString(),
          failures: 0,
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
