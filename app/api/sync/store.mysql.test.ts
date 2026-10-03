import { afterAll, describe, expect, it } from "vitest";
import { SyncStore } from "./store";
import { makeOperation, materialize } from "../../contracts/sync";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "./blobs";
import { digest } from "./store";
import { importLegacy, legacyBookImport } from "./legacy";
import { createSyncApi } from "./api";

const url = process.env.SYNC_TEST_DATABASE_URL;
describe.skipIf(!url)("real MySQL replication transactions", () => {
  const workspace = `test-${randomUUID()}`;
  const store = new SyncStore(
    url ?? "mysql://localhost/test",
    workspace,
    "test-node"
  );
  afterAll(async () => {
    for (const table of ["sync_snapshot_entities"])
      await store.pool.query(
        `DELETE FROM ${table} WHERE snapshot_id IN (SELECT id FROM sync_snapshots WHERE workspace=?)`,
        [workspace]
      );
    for (const table of [
      "sync_operations",
      "sync_entities",
      "sync_cursors",
      "sync_credentials",
      "sync_snapshots",
      "sync_heads",
    ])
      await store.pool.query(`DELETE FROM ${table} WHERE workspace=?`, [
        workspace,
      ]);
    await store.close();
  });
  it("deduplicates, detects ID reuse, preserves snapshot watermarks and survives restart", async () => {
    await store.initialize();
    const a = makeOperation(
      workspace,
      "a",
      "notes",
      "n",
      { title: "local" },
      1
    );
    const b = makeOperation(
      workspace,
      "b",
      "notes",
      "n",
      { content: "remote" },
      2
    );
    const results = await Promise.all([store.accept(a), store.accept(b)]);
    expect(new Set(results.map(r => r.seq)).size).toBe(2);
    expect((await store.accept(a)).duplicate).toBe(true);
    await expect(
      store.accept({ ...a, patch: { title: "tampered" } })
    ).rejects.toThrow("operation_id_reused");
    await expect(store.accept({ ...a, workspaceId: "wrong" })).rejects.toThrow(
      "workspace_mismatch"
    );
    const snapshot = await store.snapshot();
    await store.accept(
      makeOperation(workspace, "a", "notes", "later", { title: "later" }, 3)
    );
    expect((await store.snapshotPage(snapshot.id)).entities).toHaveLength(1);
    expect((await store.changes(snapshot.cursor)).operations).toHaveLength(1);
    expect(
      materialize(
        (await store.entities("notes")).entities.find(e => e.id === "n")!
      )
    ).toEqual({ id: "n", title: "local", content: "remote" });
    await store.credential("peer", "secret");
    expect(await store.authorized("secret")).toBe(true);
    await store.revoke("peer");
    expect(await store.authorized("secret")).toBe(false);
  });
  it("migrates legacy source chunks only after verification and retains originals", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-migration-"));
    const id = `migration-${randomUUID()}`;
    const bytes = Buffer.from("A migrated original book.\n");
    const hash = digest(bytes);
    const manifest = {
      uploadId: hash,
      sha256: hash,
      size: bytes.length,
      chunks: 1,
      name: "legacy.txt",
      type: "text/plain",
    };
    try {
      await store.pool.query(
        "INSERT INTO mirror_books(ext_id,title,format,chapters,source_manifest) VALUES (?,?,?,?,?)",
        [id, "Legacy", "txt", "[]", JSON.stringify(manifest)]
      );
      await store.pool.query(
        "INSERT INTO library_source_chunks VALUES (?,?,0,?)",
        [id, hash, bytes.toString("base64")]
      );
      await importLegacy(store, new BlobStore(root));
      expect(await readFile(new BlobStore(root).path(hash))).toEqual(bytes);
      expect(materialize((await store.entity("sources", id))!)?.sha256).toBe(
        hash
      );
      const [rows] = await store.pool.query(
        "SELECT * FROM library_source_chunks WHERE book_ext_id=?",
        [id]
      );
      expect(rows).toHaveLength(1);
    } finally {
      await store.pool.query(
        "DELETE FROM library_source_chunks WHERE book_ext_id=?",
        [id]
      );
      await store.pool.query("DELETE FROM mirror_books WHERE ext_id=?", [id]);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("bridges the existing chunked book import into one canonical operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-legacy-import-"));
    const extId = randomUUID();
    const uploadId = randomUUID();
    const payload = JSON.stringify([
      { id: "c", title: "Legacy", paragraphs: ["Legacy client"] },
    ]);
    const input = {
      extId,
      uploadId,
      chunkCount: 1,
      encodedBytes: Buffer.byteLength(payload),
      title: "Legacy upload",
      author: "",
      format: "txt",
      folder: "",
      contentHash: "",
      chapterCount: 1,
    };
    try {
      const blobs = new BlobStore(root);
      await legacyBookImport(store, blobs, "book.import.started", input);
      await legacyBookImport(store, blobs, "book.import.chunk", {
        extId,
        uploadId,
        index: 0,
        chunkCount: 1,
        payload,
      });
      const completion = {
        extId,
        uploadId,
        chunkCount: 1,
        encodedBytes: Buffer.byteLength(payload),
      };
      await legacyBookImport(store, blobs, "book.import.completed", completion);
      await legacyBookImport(store, blobs, "book.import.completed", completion);
      expect(await store.history("books", extId)).toHaveLength(1);
      expect(materialize((await store.entity("books", extId))!)?.title).toBe(
        "Legacy upload"
      );
    } finally {
      await store.pool.query(
        "DELETE FROM mirror_book_upload_chunks WHERE book_ext_id=?",
        [extId]
      );
      await rm(root, { recursive: true, force: true });
    }
  });
  it("returns per-item receipts, rejects mutable review IDs and restores using new identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-api-"));
    try {
      await store.credential("api-test", "api-token");
      const { api } = createSyncApi(store, new BlobStore(root));
      const headers = {
        Authorization: "Bearer api-token",
        "X-Workspace-Id": workspace,
        "Content-Type": "application/json",
      };
      const op = makeOperation(workspace, "a", "notes", "restore-original", {
        title: "Recover",
        content: "Saved",
      });
      const response = await api.request("/sync/push", {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [op, { ...op, workspaceId: "wrong" }],
        }),
      });
      expect(
        ((await response.json()) as { receipts: unknown[] }).receipts
      ).toMatchObject([
        { operationId: op.operationId },
        { error: "workspace_mismatch", persisted: false },
      ]);
      await store.accept({
        ...makeOperation(workspace, "a", "notes", op.entityId, {}),
        deleted: true,
      });
      const restore = await api.request(
        `/entities/notes/${op.entityId}/restore`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: randomUUID(),
            newEntityId: "restored-new",
          }),
        }
      );
      expect(restore.status).toBe(200);
      expect(
        materialize((await store.entity("notes", "restored-new"))!)?.content
      ).toBe("Saved");
      expect((await store.entity("notes", op.entityId))?.deleted).toBe(true);
      await expect(
        store.accept(makeOperation(workspace, "a", "reviews", "mutable", {}))
      ).rejects.toThrow("immutable_review");
      const fresh = new SyncStore(url!, workspace, "test-node");
      await fresh.initialize();
      expect((await fresh.entity("notes", "restored-new"))?.deleted).toBe(
        false
      );
      await fresh.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("commits API book deletion and related tombstones together", async () => {
    await store.accept(
      makeOperation(workspace, "a", "books", "cascade-book", { title: "Book" })
    );
    await store.accept(
      makeOperation(workspace, "a", "highlights", "cascade-highlight", {
        bookId: "cascade-book",
        text: "Quote",
      })
    );
    const op = {
      ...makeOperation(workspace, "a", "books", "cascade-book", {}),
      deleted: true,
    };
    await store.mutate(op);
    expect(
      (await store.entity("highlights", "cascade-highlight"))?.deleted
    ).toBe(true);
    expect((await store.mutate(op)).duplicate).toBe(true);
  });
  it("does not commit a migrated book when its original file cannot be verified", async () => {
    const isolated = new SyncStore(
      url!,
      `test-${randomUUID()}`,
      "atomic-import"
    );
    const root = await mkdtemp(join(tmpdir(), "sync-atomic-import-"));
    const id = randomUUID();
    try {
      await isolated.initialize();
      const manifest = {
        sha256: "a".repeat(64),
        size: 10,
        name: "missing.txt",
        type: "text/plain",
        uploadId: "missing",
      };
      await store.pool.query(
        "INSERT INTO mirror_books(ext_id,title,format,chapters,source_manifest) VALUES (?,?,?,?,?)",
        [id, "Missing source", "txt", "[]", JSON.stringify(manifest)]
      );
      await expect(importLegacy(isolated, new BlobStore(root))).rejects.toThrow(
        "missing_chunks"
      );
      expect(await isolated.entity("books", id)).toBeUndefined();
      expect(await isolated.entity("sources", id)).toBeUndefined();
    } finally {
      await store.pool.query("DELETE FROM mirror_books WHERE ext_id=?", [id]);
      for (const table of [
        "sync_operations",
        "sync_entities",
        "sync_cursors",
        "sync_heads",
      ])
        await store.pool.query(`DELETE FROM ${table} WHERE workspace=?`, [
          isolated.workspace,
        ]);
      await isolated.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
