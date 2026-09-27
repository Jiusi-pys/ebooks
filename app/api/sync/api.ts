import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { requireBrowserMutation, requireBrowserSession } from "../auth";
import { extractKey, validKey } from "../lib/openapi-auth";
import {
  identifier,
  makeOperation,
  nextClock,
  entityKinds,
} from "../../contracts/sync";
import { SyncError, SyncStore } from "./store";
import { BlobStore, chunkSize } from "./blobs";
import { replication, type Peer } from "./replication";
import { importLegacy } from "./legacy";
import { syncOpenApi } from "../../contracts/sync-openapi";
import { setActiveSyncStore } from "./active";

export function createSyncApi(
  store: SyncStore,
  blobs: BlobStore,
  peers: Peer[] = []
) {
  const api = new Hono<{ Variables: { admin: boolean } }>();
  const worker = replication(store, blobs, peers);
  api.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const key = extractKey(c);
    if (key && validKey(key)) {
      c.set("admin", true);
      return next();
    }
    if (key) {
      if (
        c.req.header("X-Workspace-Id") !== store.workspace ||
        !(await store.authorized(key))
      )
        return c.json({ error: "unauthorized" }, 401);
      c.set("admin", false);
      return next();
    }
    c.set("admin", true);
    return c.req.method === "GET" || c.req.method === "HEAD"
      ? requireBrowserSession(c, next)
      : requireBrowserMutation(c, next);
  });
  api.onError((error, c) => {
    if (error instanceof SyntaxError)
      return c.json({ error: "invalid_json" }, 400);
    if (error instanceof ZodError)
      return c.json({ error: "validation_failed", issues: error.issues }, 400);
    if (error instanceof SyncError)
      return c.json({ error: error.code }, error.status as 400);
    console.error("[sync]", error.message);
    return c.json({ error: "sync_unavailable" }, 503);
  });
  api.get("/capabilities", async c =>
    c.json({
      version: 2,
      workspaceId: store.workspace,
      nodeId: store.nodeId,
      epoch: (await store.head()).epoch,
      kinds: entityKinds,
      maxBatch: 100,
      maxBytes: 1024 * 1024,
      chunkSize,
    })
  );
  api.get("/openapi.json", c => c.json(syncOpenApi));
  api.post("/sync/push", async c => {
    const body = await c.req.json();
    if (!Array.isArray(body.operations) || body.operations.length > 100)
      throw new SyncError("invalid_batch");
    const receipts = [];
    for (const op of body.operations) {
      try {
        receipts.push(await store.accept(op));
      } catch (error) {
        if (body.operations.length === 1) throw error;
        receipts.push({
          operationId: op?.operationId ?? null,
          error:
            error instanceof SyncError
              ? error.code
              : error instanceof ZodError
                ? "validation_failed"
                : "sync_unavailable",
          persisted: false,
        });
      }
    }
    return c.json({ receipts });
  });
  api.get("/sync/changes", async c =>
    c.json(await store.changes(c.req.query("cursor")))
  );
  api.post("/sync/snapshots", async c => c.json(await store.snapshot(), 201));
  api.get("/sync/snapshots/:id", async c =>
    c.json(
      await store.snapshotPage(
        identifier.parse(c.req.param("id")),
        c.req.query("after")
      )
    )
  );
  api.get("/entities", async c =>
    c.json(await store.entities(c.req.query("kind"), c.req.query("after")))
  );
  api.post("/entities/:kind/:id/restore", async c => {
    const input = await c.req.json();
    const operationId = identifier.parse(input.operationId);
    const id = identifier.parse(input.newEntityId ?? operationId);
    if (id === c.req.param("id"))
      throw new SyncError("restore_requires_new_entity_id");
    const state = await store.entity(c.req.param("kind"), c.req.param("id"));
    if (!state) throw new SyncError("entity_not_found", 404);
    if (state.kind === "reviews")
      throw new SyncError("review_events_are_immutable");
    const prior = await store.operation(operationId);
    const patch = Object.fromEntries(
      Object.entries(state.fields)
        .filter(([, field]) => !field.removed)
        .map(([key, field]) => [key, field.value])
    );
    const op = {
      ...makeOperation(store.workspace, store.nodeId, state.kind, id, patch),
      operationId,
      clock: prior?.clock ?? nextClock((await store.head()).clock),
    };
    // A retry must replay the original restored content even if its source changed.
    if (prior && (prior.entityId !== id || prior.kind !== state.kind))
      throw new SyncError("operation_id_reused", 409);
    return c.json({ entityId: id, receipt: await store.accept(prior ?? op) });
  });
  api.get("/entities/:kind/:id/history", async c =>
    c.json({
      operations: await store.history(c.req.param("kind"), c.req.param("id")),
    })
  );
  api.post("/mutations", async c => {
    const input = await c.req.json();
    const operationId = input.operationId ?? randomUUID();
    const previous = await store.operation(operationId);
    const op = {
      ...makeOperation(
        store.workspace,
        store.nodeId,
        input.kind,
        input.kind === "reviews" ? operationId : input.entityId,
        input.patch ?? {}
      ),
      operationId,
      clock:
        input.clock ?? previous?.clock ?? nextClock((await store.head()).clock),
      deleted: input.deleted ?? false,
      unset: input.unset ?? [],
    };
    return c.json(await store.mutate(op));
  });
  api.get("/status", async c =>
    c.json({
      nodeId: store.nodeId,
      workspaceId: store.workspace,
      sequence: String((await store.head()).seq),
      peers: worker.status,
    })
  );
  api.post("/peers", async c => {
    if (!c.get("admin")) return c.json({ error: "owner_required" }, 403);
    const id = identifier.parse((await c.req.json()).id);
    const token = randomBytes(32).toString("base64url");
    await store.credential(id, token);
    return c.json({ id, token, workspaceId: store.workspace }, 201);
  });
  api.delete("/peers/:id", async c => {
    if (!c.get("admin")) return c.json({ error: "owner_required" }, 403);
    await store.revoke(identifier.parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  api.post("/blobs/uploads", async c =>
    c.json(await blobs.create(await c.req.json()), 201)
  );
  api.get("/blobs/uploads/:id", async c =>
    c.json(await blobs.status(c.req.param("id")))
  );
  api.put("/blobs/uploads/:id/:index", async c => {
    await blobs.put(
      c.req.param("id"),
      Number(c.req.param("index")),
      Buffer.from(await c.req.arrayBuffer()),
      c.req.header("X-Chunk-SHA256") ?? ""
    );
    return c.json({ ok: true });
  });
  api.post("/blobs/uploads/:id/commit", async c =>
    c.json(await blobs.commit(c.req.param("id")))
  );
  api.get("/blobs/:hash/chunks/:index", async c => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0 || index >= 1024)
      throw new SyncError("invalid_chunk");
    if (!(await blobs.has(c.req.param("hash"))))
      throw new SyncError("blob_not_found", 404);
    const file = await open(blobs.path(c.req.param("hash")), "r");
    try {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await file.read(
        buffer,
        0,
        chunkSize,
        index * chunkSize
      );
      return c.body(buffer.subarray(0, bytesRead), 200, {
        "Content-Type": "application/octet-stream",
      });
    } finally {
      await file.close();
    }
  });
  api.get("/blobs/:hash", async c => {
    if (!(await blobs.has(c.req.param("hash"))))
      throw new SyncError("blob_not_found", 404);
    return c.body(
      Readable.toWeb(
        createReadStream(blobs.path(c.req.param("hash")))
      ) as ReadableStream<Uint8Array>,
      200,
      { "Content-Type": "application/octet-stream" }
    );
  });
  return { api, worker };
}

export async function configureSync() {
  const workspace = identifier.parse(process.env.SYNC_WORKSPACE_ID);
  const node = identifier.parse(process.env.SYNC_NODE_ID);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const store = new SyncStore(process.env.DATABASE_URL, workspace, node);
  await store.initialize();
  const blobs = new BlobStore(
    process.env.SYNC_BLOB_DIR ?? `.runtime/blobs/${workspace}`
  );
  await importLegacy(store, blobs);
  setActiveSyncStore(store);
  const peers: Peer[] = JSON.parse(process.env.SYNC_PEERS_JSON ?? "[]");
  for (const peer of peers) {
    identifier.parse(peer.id);
    const url = new URL(peer.url);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )
    )
      throw new Error("Replication requires HTTPS or an SSH loopback tunnel");
  }
  return { ...createSyncApi(store, blobs, peers), store, blobs };
}
