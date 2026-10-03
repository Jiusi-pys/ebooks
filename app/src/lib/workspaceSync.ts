import { applyPreferences, preferenceKeys } from "./syncPreferences";
import { syncDatabase, type StoredFile } from "./db";
import { sharedCore } from "@contracts/core-runtime";
import {
  receiveOperations,
  trackDatabase,
  syncStores,
  stageOperationFields,
} from "./syncDatabase";
import {
  abandonSnapshot,
  beginSnapshot,
  stageSnapshot,
  finishSnapshot,
} from "./syncSnapshots";
import {
  applyOperation,
  entityKinds,
  isBlobReference,
  makeOperation,
  materialize,
  projectable,
} from "@contracts/sync";

interface Capabilities {
  workspaceId: string;
  nodeId: string;
  epoch: string;
}
let capabilities: Capabilities | undefined;
let running: Promise<void> | undefined;
export const isWorkspaceSyncActive = () =>
  !!capabilities ||
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("shufang:sync-v2") === "true");
export async function syncRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/v2${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 160);
    if (
      [400, 409].includes(response.status) &&
      path.startsWith("/sync/changes") &&
      /cursor/.test(errorText) &&
      capabilities
    ) {
      const db = await syncDatabase();
      await db.delete(
        "syncMeta",
        `cursor:${capabilities.nodeId}:${capabilities.epoch}`
      );
      await abandonSnapshot(
        db,
        `cursor:${capabilities.nodeId}:${capabilities.epoch}`
      );
      capabilities = undefined;
    }
    throw new Error(`Sync request failed (${response.status}): ${errorText}`);
  }
  return response;
}
async function enabled() {
  if (capabilities) return true;
  const response = await fetch("/api/v2/capabilities", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) {
    if (isWorkspaceSyncActive())
      throw new Error("服务端已停用工作区同步；本机待同步记录已保留");
    return false;
  }
  if (!response.ok) throw new Error(`同步服务不可用 (${response.status})`);
  const body = await response.json();
  if (body.version !== 2) return false;
  capabilities = body;
  localStorage.setItem("shufang:sync-v2", "true");
  return true;
}
async function initialize() {
  const db = await syncDatabase();
  const stores = entityKinds.filter(kind => db.objectStoreNames.contains(kind));
  const tx = db.transaction([...stores, "files", ...syncStores], "readwrite");
  const meta = tx.objectStore("syncMeta");
  const identity = (await meta.get("identity")) ?? {
    id: "identity",
    replica: crypto.randomUUID(),
    clock: "0:0",
    workspace: "unpaired",
  };
  if (
    identity.workspace !== "unpaired" &&
    identity.workspace !== capabilities!.workspaceId
  ) {
    tx.abort();
    throw new Error("本地工作区与服务端不一致；请先导出本地数据");
  }
  identity.workspace = capabilities!.workspaceId;
  await meta.put(identity);
  if (!(await meta.get("projection-v1"))) {
    for (const row of await tx.objectStore("syncEntities").getAll()) {
      if (!stores.includes(row.state.kind)) continue;
      const data = materialize(row.state);
      if (data && projectable(row.state.kind, data))
        await tx.objectStore(row.state.kind).put(data);
      else await tx.objectStore(row.state.kind).delete(row.state.id);
    }
    await meta.put({ id: "projection-v1", complete: true });
  }
  for (const row of await tx.objectStore("syncOutbox").getAll()) {
    if (row.operation.workspaceId !== identity.workspace) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error(
        "历史待发操作所属工作区不同，已保留原 ID 和内容；必须先完成显式增量迁移"
      );
    }
  }
  if (!(await meta.get("seeded"))) {
    for (const kind of stores) {
      for (const record of await tx.objectStore(kind).getAll()) {
        const key = `${kind}:${record.id}`;
        if (await tx.objectStore("syncEntities").get(key)) continue;
        const { id, ...patch } = record;
        const op = makeOperation(
          identity.workspace,
          identity.replica,
          kind,
          id,
          await stageOperationFields(meta, JSON.parse(JSON.stringify(patch))),
          0
        );
        await tx
          .objectStore("syncEntities")
          .put({ id: key, state: applyOperation(undefined, op) });
        await tx
          .objectStore("syncOutbox")
          .put({ id: op.operationId, operation: op });
      }
    }
    for (const key of preferenceKeys) {
      const value = localStorage.getItem(key);
      if (
        value !== null &&
        !(await tx.objectStore("syncEntities").get(`preferences:${key}`))
      ) {
        const operation = makeOperation(
          identity.workspace,
          identity.replica,
          "preferences",
          key,
          { value },
          0
        );
        await tx.objectStore("syncEntities").put({
          id: `preferences:${key}`,
          state: applyOperation(undefined, operation),
        });
        await tx
          .objectStore("syncOutbox")
          .put({ id: operation.operationId, operation });
      }
    }
    await meta.put({ id: "seeded", complete: true });
  }
  if (!(await meta.get("seeded-files"))) {
    for (const id of await tx.objectStore("files").getAllKeys()) {
      if (!(await tx.objectStore("syncEntities").get(`sources:${id}`)))
        await meta.put({
          id: `file:${id}`,
          pending: true,
          revision: crypto.randomUUID(),
        });
    }
    await meta.put({ id: "seeded-files", complete: true });
  }
  await tx.done;
}
const sha = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
interface UploadManifest {
  sha256: string;
  size: number;
  name: string;
  type: string;
}
function uploadId(input: unknown): string {
  const id = (input as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !/^[\w.:-]{1,128}$/.test(id))
    throw new Error("invalid_upload_session");
  return id;
}
function sameUpload(input: unknown, expected: UploadManifest) {
  const manifest = input as Partial<UploadManifest> | null;
  return (
    manifest?.sha256 === expected.sha256 && manifest.size === expected.size
  );
}
function missingChunks(input: unknown, expected: UploadManifest): number[] {
  const status = input as { manifest?: unknown; missing?: unknown } | null;
  if (
    !sameUpload(status?.manifest, expected) ||
    !Array.isArray(status?.missing)
  )
    throw new Error("invalid_upload_progress");
  const count = Math.ceil(expected.size / 262144);
  const missing = status.missing;
  if (
    missing.length > count ||
    new Set(missing).size !== missing.length ||
    missing.some(
      index => !Number.isInteger(index) || index < 0 || index >= count
    )
  )
    throw new Error("invalid_upload_progress");
  return missing as number[];
}
async function uploadPayload(bytes: ArrayBuffer, name: string, type: string) {
  const hash = await sha(bytes);
  const manifest = { sha256: hash, size: bytes.byteLength, name, type };
  const db = await syncDatabase();
  const key = `payload:${hash}`;
  let session = await db.get("syncMeta", key);
  if (!session) {
    const upload = await (
      await syncRequest("/blobs/uploads", {
        method: "POST",
        body: JSON.stringify(manifest),
      })
    ).json();
    session = { id: key, uploadId: uploadId(upload) };
    await db.put("syncMeta", session);
  }
  const status = await (
    await syncRequest(`/blobs/uploads/${session.uploadId}`)
  ).json();
  for (const index of missingChunks(status, manifest)) {
    const part = bytes.slice(index * 262144, (index + 1) * 262144);
    await syncRequest(`/blobs/uploads/${session.uploadId}/${index}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Chunk-SHA256": await sha(part),
      },
      body: part,
    });
  }
  const committed = await (
    await syncRequest(`/blobs/uploads/${session.uploadId}/commit`, {
      method: "POST",
    })
  ).json();
  if (!sameUpload(committed, manifest))
    throw new Error("invalid_upload_acknowledgement");
  return manifest;
}
async function hydratePending() {
  const db = await syncDatabase();
  let changed = false;
  for (const row of await db.getAll("syncEntities")) {
    const hydrated = new Map<
      string,
      { version: string; value: unknown; hash: string }
    >();
    for (const [key, field] of Object.entries(row.state.fields) as [
      string,
      { value: unknown; version: string },
    ][]) {
      if (!isBlobReference(field.value)) continue;
      try {
        const ref = field.value.$blob;
        const bytes = await (
          await syncRequest(`/blobs/${ref.sha256}`, {
            signal: AbortSignal.timeout(10_000),
          })
        ).arrayBuffer();
        if (bytes.byteLength !== ref.size || (await sha(bytes)) !== ref.sha256)
          throw new Error("Content checksum mismatch");
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        );
        hydrated.set(key, { version: field.version, value, hash: ref.sha256 });
      } catch {
        /* Metadata and local outbox continue; retry missing payloads next cycle. */
      }
    }
    if (!hydrated.size || !db.objectStoreNames.contains(row.state.kind))
      continue;
    const tx = db.transaction(["syncEntities", row.state.kind], "readwrite");
    const current = await tx.objectStore("syncEntities").get(row.id);
    if (current) {
      const projection = structuredClone(current.state);
      for (const [key, payload] of hydrated) {
        const field = projection.fields[key];
        if (
          field?.version === payload.version &&
          isBlobReference(field.value) &&
          field.value.$blob.sha256 === payload.hash
        )
          field.value = payload.value;
      }
      const data = materialize(projection);
      if (data && projectable(current.state.kind, data)) {
        await tx.objectStore(current.state.kind).put(data);
        changed = true;
      }
    }
    // Hydration updates only the view projection, never same-version sync metadata.
    await tx.done;
  }
  return changed;
}
async function uploadFiles() {
  const db = await syncDatabase();
  for (const pending of (await db.getAll("syncMeta")).filter(
    row => row.id.startsWith("file:") && row.pending
  )) {
    const id = pending.id.slice(5);
    const file: StoredFile | undefined = await db.get("files", id);
    if (!file) {
      await db.delete("syncMeta", pending.id);
      continue;
    }
    const bytes =
      file.data instanceof Blob ? await file.data.arrayBuffer() : file.data;
    const hash = await sha(bytes);
    const manifest = {
      sha256: hash,
      size: bytes.byteLength,
      name: file.name ?? `${id}.${file.type}`,
      type:
        file.data instanceof Blob ? file.data.type : "application/octet-stream",
      format: file.type,
    };
    const resumeKey = `upload:${id}:${hash}`;
    let session = await db.get("syncMeta", resumeKey);
    if (!session) {
      const created = await (
        await syncRequest("/blobs/uploads", {
          method: "POST",
          body: JSON.stringify(manifest),
        })
      ).json();
      session = { id: resumeKey, uploadId: uploadId(created) };
      await db.put("syncMeta", session);
    }
    const status = await (
      await syncRequest(`/blobs/uploads/${session.uploadId}`)
    ).json();
    for (const index of missingChunks(status, manifest)) {
      const part = bytes.slice(index * 262144, (index + 1) * 262144);
      await syncRequest(`/blobs/uploads/${session.uploadId}/${index}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Chunk-SHA256": await sha(part),
        },
        body: part,
      });
    }
    const committed = await (
      await syncRequest(`/blobs/uploads/${session.uploadId}/commit`, {
        method: "POST",
      })
    ).json();
    if (!sameUpload(committed, manifest))
      throw new Error("invalid_upload_acknowledgement");
    await trackDatabase(db).put("sources", { id, ...manifest });
    const done = db.transaction("syncMeta", "readwrite");
    const current = await done.store.get(pending.id);
    if (current?.revision === pending.revision)
      await done.store.delete(pending.id);
    await done.done;
  }
}
async function exchange(recovering = false) {
  if (!capabilities && !(await enabled())) return;
  await initialize();
  const db = await syncDatabase();
  const key = `cursor:${capabilities!.nodeId}:${capabilities!.epoch}`;
  let received = false;
  const position = await db.get("syncMeta", key);
  if (
    !position ||
    Date.now() - (position.snapshotAt ?? 0) >= 300_000 ||
    (await db.get("syncMeta", `snapshot:${key}`))
  ) {
    const snapshotKey = `snapshot:${key}`;
    let checkpoint = await db.get("syncMeta", snapshotKey);
    if (checkpoint && checkpoint.version !== 1) {
      await abandonSnapshot(db, key);
      checkpoint = undefined;
    }
    if (!checkpoint) {
      const snapshot = await (
        await syncRequest("/sync/snapshots", { method: "POST" })
      ).json();
      await beginSnapshot(db, key, snapshot);
      checkpoint = await db.get("syncMeta", snapshotKey);
    }
    while (true) {
      if (checkpoint.after === null) {
        await finishSnapshot(db, key, Date.now());
        received = true;
        break;
      }
      let response: Response;
      try {
        response = await syncRequest(
          `/sync/snapshots/${checkpoint.snapshotId}?after=${encodeURIComponent(checkpoint.after)}`
        );
      } catch (error) {
        if (
          error instanceof Error &&
          /Sync request failed \((404|410)\)/.test(error.message)
        )
          await abandonSnapshot(db, key);
        throw error;
      }
      const page = await response.json();
      await stageSnapshot(db, key, page, {
        after: checkpoint.after,
        pages: checkpoint.pages,
      });
      checkpoint = await db.get("syncMeta", snapshotKey);
      received ||= page.entities.length > 0;
    }
  }
  // Pull first: field versions merge remote changes with pending local edits.
  let more = true;
  while (more) {
    const cursor = (await db.get("syncMeta", key))?.cursor;
    let response: Response;
    try {
      response = await syncRequest(
        `/sync/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
      );
    } catch (error) {
      if (
        !recovering &&
        error instanceof Error &&
        /Sync request failed \((400|409)\).*cursor/.test(error.message)
      )
        return exchange(true);
      throw error;
    }
    const page = await response.json();
    received ||= page.operations.length > 0;
    await receiveOperations(db, page.operations, key, page.cursor);
    more = page.hasMore;
  }
  await applyPreferences();
  await uploadFiles();
  const pending = await db.getAll("syncOutbox");
  for (const item of pending) {
    for (const value of Object.values(item.operation.patch)) {
      if (!isBlobReference(value)) continue;
      const ref = value.$blob;
      const object = await db.get("syncMeta", `field:${ref.sha256}`);
      if (!object) continue; // A received reference may already exist remotely.
      if (
        object.version !== 1 ||
        Object.prototype.toString.call(object.bytes) !==
          "[object ArrayBuffer]" ||
        object.bytes.byteLength !== ref.size ||
        (await sha(object.bytes)) !== ref.sha256
      )
        throw new Error("本地字段对象校验失败，原操作已保留");
      const uploaded = await uploadPayload(
        object.bytes,
        "field.json",
        "application/json"
      );
      if (uploaded.sha256 !== ref.sha256 || uploaded.size !== ref.size)
        throw new Error("上传字段对象与原操作引用不一致");
    }
    const response = await syncRequest("/sync/push", {
      method: "POST",
      body: JSON.stringify({ operations: [item.operation] }),
    });
    const result: { receipts?: unknown } = await response.json();
    sharedCore().execute("validateSyncReceipts", {
      operationIds: [item.operation.operationId],
      receipts: result.receipts ?? null,
    });
    await db.delete("syncOutbox", item.id);
  }
  received = (await hydratePending()) || received;
  for (const pin of (await db.getAll("syncMeta")).filter(
    row => row.id.startsWith("pin:") && row.pinned
  )) {
    const id = pin.id.slice(4);
    if (!(await db.get("files", id))) {
      try {
        await downloadSource(id);
      } catch {
        /* Retain pin and retry. */
      }
    }
  }
  if (received) window.dispatchEvent(new Event("shufang:sync-updated"));
}
export async function trySyncWorkspace() {
  if (!(await enabled())) return false;
  if (!running) {
    running = (
      navigator.locks
        ? navigator.locks.request("shufang-workspace-sync", () => exchange())
        : exchange()
    )
      .then(() => undefined)
      .finally(() => {
        running = undefined;
      });
  }
  await running;
  return true;
}
export async function downloadSource(
  id: string
): Promise<StoredFile | undefined> {
  if (!isWorkspaceSyncActive()) return;
  const db = await syncDatabase();
  const row = await db.get("syncEntities", `sources:${id}`);
  const source = row ? materialize(row.state) : null;
  if (!source) return;
  const bytes = await (
    await syncRequest(`/blobs/${source.sha256}`)
  ).arrayBuffer();
  if (bytes.byteLength !== source.size || (await sha(bytes)) !== source.sha256)
    throw new Error("文件校验失败");
  const file: StoredFile = {
    id,
    name: String(source.name),
    type: source.format as StoredFile["type"],
    data: new Blob([bytes], { type: String(source.type) }),
  };
  await db.put("files", file);
  return file;
}
export async function workspaceStatus() {
  const db = await syncDatabase();
  return {
    pendingContent: (await db.getAll("syncEntities")).filter(row =>
      Object.values(row.state.fields).some(field =>
        isBlobReference((field as { value: unknown }).value)
      )
    ).length,
    pending: await db.count("syncOutbox"),
    pendingFiles: (await db.getAll("syncMeta")).filter(
      row => row.id.startsWith("file:") && row.pending
    ).length,
    server: await (await syncRequest("/status")).json(),
  };
}
