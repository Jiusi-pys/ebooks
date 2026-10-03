import "fake-indexeddb/auto";
import { openDB, deleteDB } from "idb";
import { expect, it } from "vitest";
import { beginSnapshot, stageSnapshot, finishSnapshot } from "./syncSnapshots";
import { upgradeSyncDatabase, trackDatabase } from "./syncDatabase";
import { applyOperation, makeOperation } from "@contracts/sync";

it("rejects finalization after another receiver advances the cursor", async () => {
  const name = crypto.randomUUID();
  const db = await openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore("notes", { keyPath: "id" });
      upgradeSyncDatabase(db);
    },
  });
  const key = "cursor:server:epoch";
  try {
    await db.put("syncMeta", { id: key, cursor: "before" });
    await beginSnapshot(db, key, { id: "snapshot", cursor: "watermark" });
    await stageSnapshot(
      db,
      key,
      { cursor: "watermark", entities: [], next: null },
      { after: "", pages: 0 }
    );
    await db.put("syncMeta", { id: key, cursor: "advanced" });
    const before = await db.getAll("syncMeta");
    await expect(finishSnapshot(db, key, 100)).rejects.toThrow(
      "snapshot_cursor_changed"
    );
    expect(await db.getAll("syncMeta")).toEqual(before);
  } finally {
    db.close();
    await deleteDB(name);
  }
});

it("stages pages through restart and atomically merges without deleting local pending operations", async () => {
  const name = crypto.randomUUID();
  let db = await openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore("notes", { keyPath: "id" });
      upgradeSyncDatabase(db);
    },
  });
  const key = "cursor:server:epoch";
  const remote = applyOperation(
    undefined,
    makeOperation(
      "workspace",
      "server",
      "notes",
      "remote",
      { title: "remote", content: "\ud800", createdAt: 1, updatedAt: 1 },
      1
    )
  );
  try {
    await beginSnapshot(db, key, { id: "snapshot", cursor: "watermark" });
    await stageSnapshot(
      db,
      key,
      {
        cursor: "watermark",
        entities: [remote],
        next: "notes:remote",
      },
      { after: "", pages: 0 }
    );
    expect(await db.get("notes", "remote")).toBeUndefined();
    expect(await db.get("syncMeta", key)).toBeUndefined();
    db.close();
    db = await openDB(name, 1);
    await trackDatabase(db).put("notes", {
      id: "local",
      title: "local",
      content: "keep",
      createdAt: 1,
      updatedAt: 1,
    });
    const pending = await db.getAll("syncOutbox");
    await stageSnapshot(
      db,
      key,
      {
        cursor: "watermark",
        entities: [],
        next: null,
      },
      { after: "notes:remote", pages: 1 }
    );
    await finishSnapshot(db, key, 100);
    expect(await db.get("notes", "remote")).toMatchObject({
      content: "\ud800",
    });
    expect(await db.get("notes", "local")).toMatchObject({ content: "keep" });
    expect(await db.getAll("syncOutbox")).toEqual(pending);
    expect(await db.get("syncMeta", key)).toEqual({
      id: key,
      cursor: "watermark",
      snapshotAt: 100,
    });
    expect(await db.get("syncMeta", `snapshot:${key}`)).toBeUndefined();
  } finally {
    db.close();
    await deleteDB(name);
  }
});

it("rejects stale page responses and rolls back a failed final merge", async () => {
  const name = crypto.randomUUID();
  const db = await openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore("notes", { keyPath: "id" });
      upgradeSyncDatabase(db);
    },
  });
  const key = "cursor:server:epoch";
  const state = (id: string, content: string) =>
    applyOperation(
      undefined,
      makeOperation(
        "workspace",
        "server",
        "notes",
        id,
        { title: id, content, createdAt: 1, updatedAt: 1 },
        1
      )
    );
  try {
    await beginSnapshot(db, key, { id: "snapshot", cursor: "watermark" });
    await stageSnapshot(
      db,
      key,
      { cursor: "watermark", entities: [state("first", "ok")], next: "next" },
      { after: "", pages: 0 }
    );
    await expect(
      stageSnapshot(
        db,
        key,
        { cursor: "watermark", entities: [], next: null },
        { after: "", pages: 0 }
      )
    ).rejects.toThrow("snapshot_page_mismatch");
    await stageSnapshot(
      db,
      key,
      {
        cursor: "watermark",
        entities: [state("collision", "incoming")],
        next: null,
      },
      { after: "next", pages: 1 }
    );
    const collision = state("collision", "incoming");
    collision.fields.content.value = "local";
    const staged = await db.get("syncMeta", `snapshot-page:${key}:1`);
    collision.fields.content.version =
      staged.entities[0].fields.content.version;
    await db.put("syncEntities", { id: "notes:collision", state: collision });
    const before = await db.getAll("syncMeta");
    await expect(finishSnapshot(db, key, 100)).rejects.toThrow(
      "field_version_reused"
    );
    expect(await db.get("notes", "first")).toBeUndefined();
    expect(await db.get("syncMeta", key)).toBeUndefined();
    expect(await db.getAll("syncMeta")).toEqual(before);
    await db.delete("syncEntities", "notes:collision");
    await finishSnapshot(db, key, 101);
    expect(await db.get("notes", "first")).toMatchObject({ content: "ok" });
  } finally {
    db.close();
    await deleteDB(name);
  }
});
