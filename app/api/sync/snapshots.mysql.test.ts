import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SyncStore } from "./store";
import { IncomingSnapshots } from "./snapshots";
import { applyOperation, makeOperation } from "../../contracts/sync";

const url = process.env.SYNC_TEST_DATABASE_URL;
describe.skipIf(!url)("MySQL staged incoming snapshots", () => {
  const workspace = `test-${randomUUID()}`;
  const store = new SyncStore(
    url ?? "mysql://localhost/test",
    workspace,
    "local"
  );
  afterAll(async () => {
    await store.pool.query(
      "DELETE FROM sync_snapshot_entities WHERE snapshot_id IN (SELECT id FROM sync_snapshots WHERE workspace=?)",
      [workspace]
    );
    for (const table of [
      "sync_operations",
      "sync_entities",
      "sync_cursors",
      "sync_snapshots",
      "sync_heads",
    ])
      await store.pool.query(`DELETE FROM ${table} WHERE workspace=?`, [
        workspace,
      ]);
    await store.close();
  });
  it("resumes staging and atomically merges while retaining original local operations", async () => {
    await store.initialize();
    const local = makeOperation(
      workspace,
      "local",
      "notes",
      "local",
      { title: "local", content: "keep" },
      5
    );
    await store.accept(local);
    const remote = applyOperation(
      undefined,
      makeOperation(
        workspace,
        "remote",
        "notes",
        "remote",
        { title: "remote", content: "\ud800" },
        1
      )
    );
    let snapshots = new IncomingSnapshots(store);
    const key = "pull:remote:epoch";
    await snapshots.begin(
      key,
      { id: "remote-snapshot", cursor: "watermark" },
      1
    );
    await snapshots.stage(
      key,
      { after: "", pages: 0 },
      { cursor: "watermark", entities: [remote], next: "next" }
    );
    expect(await store.entity("notes", "remote")).toBeUndefined();
    snapshots = new IncomingSnapshots(store);
    expect(await snapshots.pending(key)).toMatchObject({
      after: "next",
      pages: 1,
    });
    await expect(
      snapshots.stage(
        key,
        { after: "", pages: 0 },
        { cursor: "watermark", entities: [], next: null }
      )
    ).rejects.toThrow("snapshot_page_mismatch");
    await snapshots.stage(
      key,
      { after: "next", pages: 1 },
      { cursor: "watermark", entities: [], next: null }
    );
    await snapshots.finish(key, 100);
    expect(await store.entity("notes", "remote")).toEqual(remote);
    expect((await store.changes()).operations).toEqual([local]);
    expect(await store.peerCursor(key)).toBe("watermark");
    expect(await snapshots.pending(key)).toBeUndefined();
  });
  it("rolls back every state and preserves staging when the final merge conflicts", async () => {
    const remote = applyOperation(
      undefined,
      makeOperation(
        workspace,
        "remote",
        "notes",
        "collision",
        { content: "incoming" },
        10
      )
    );
    const prior = structuredClone(remote);
    prior.fields.content.value = "local";
    await store.pool.query("INSERT INTO sync_entities VALUES (?,?,?,?)", [
      workspace,
      "notes",
      "collision",
      JSON.stringify(prior),
    ]);
    const first = applyOperation(
      undefined,
      makeOperation(
        workspace,
        "remote",
        "notes",
        "before-collision",
        { content: "first" },
        10
      )
    );
    const snapshots = new IncomingSnapshots(store);
    const key = "pull:failed:epoch";
    await snapshots.begin(key, { id: "failed", cursor: "failed-watermark" }, 1);
    await snapshots.stage(
      key,
      { after: "", pages: 0 },
      { cursor: "failed-watermark", entities: [first, remote], next: null }
    );
    await expect(snapshots.finish(key, 100)).rejects.toThrow(
      "field_version_reused"
    );
    expect(await store.entity("notes", "before-collision")).toBeUndefined();
    expect(await store.peerCursor(key)).toBeUndefined();
    expect(await snapshots.pending(key)).toMatchObject({
      after: null,
      pages: 1,
    });
    await store.pool.query(
      "DELETE FROM sync_entities WHERE workspace=? AND entity_id='collision'",
      [workspace]
    );
    await snapshots.finish(key, 101);
    expect(await store.entity("notes", "collision")).toEqual(remote);
  });
  it("does not overwrite a receive cursor advanced by another worker", async () => {
    const snapshots = new IncomingSnapshots(store);
    const key = "pull:concurrent:epoch";
    await store.savePeerCursor(key, "before");
    await snapshots.begin(key, { id: "concurrent", cursor: "snapshot-end" }, 1);
    await snapshots.stage(
      key,
      { after: "", pages: 0 },
      { cursor: "snapshot-end", entities: [], next: null }
    );
    await store.savePeerCursor(key, "other-worker");
    await expect(snapshots.finish(key, 100)).rejects.toThrow(
      "snapshot_cursor_conflict"
    );
    expect(await store.peerCursor(key)).toBe("other-worker");
    expect(await snapshots.pending(key)).toMatchObject({
      after: null,
      pages: 1,
    });
    await snapshots.abandon(key);
    expect(await snapshots.pending(key)).toBeUndefined();
    expect(await store.peerCursor(key)).toBe("other-worker");
  });
});
