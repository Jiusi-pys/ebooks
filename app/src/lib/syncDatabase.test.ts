import "fake-indexeddb/auto";
import { openDB, deleteDB } from "idb";
import { describe, expect, it } from "vitest";
import {
  trackDatabase,
  upgradeSyncDatabase,
  receiveOperations,
} from "./syncDatabase";
import { makeOperation } from "@contracts/sync";

describe("durable browser operations", () => {
  it("rolls back field objects together with the aborted business operation", async () => {
    const name = crypto.randomUUID();
    const raw = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("notes", { keyPath: "id" });
        upgradeSyncDatabase(db);
      },
    });
    try {
      const tx = trackDatabase(raw).transaction("notes", "readwrite");
      await tx.store.put({ id: "abort", content: "x".repeat(200000) });
      tx.abort();
      await expect(tx.done).rejects.toThrow();
      expect(await raw.count("notes")).toBe(0);
      expect(await raw.count("syncOutbox")).toBe(0);
      expect(await raw.count("syncEntities")).toBe(0);
      expect(
        (await raw.getAll("syncMeta")).filter(row =>
          row.id.startsWith("field:")
        )
      ).toEqual([]);
    } finally {
      raw.close();
      await deleteDB(name);
    }
  });
  it("externalizes before the first operation commit and atomically retains field bytes", async () => {
    const name = crypto.randomUUID();
    const raw = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("notes", { keyPath: "id" });
        upgradeSyncDatabase(db);
      },
    });
    try {
      const note = { id: "large", content: "\ud800".repeat(30000) };
      await trackDatabase(raw).put("notes", note);
      const pending = await raw.getAll("syncOutbox");
      expect(pending).toHaveLength(1);
      const reference = pending[0].operation.patch.content;
      expect(reference).toHaveProperty("$blob.sha256");
      const field = await raw.get(
        "syncMeta",
        `field:${reference.$blob.sha256}`
      );
      expect(JSON.parse(new TextDecoder().decode(field.bytes))).toBe(
        note.content
      );
      expect(field.manifest).toEqual(reference.$blob);
      expect(await raw.get("notes", "large")).toEqual(note);
      expect(
        (await raw.get("syncEntities", "notes:large")).state.fields.content
          .value
      ).toEqual(reference);
    } finally {
      raw.close();
      await deleteDB(name);
    }
  });
  it("allocates one identity and distinct clocks for concurrent writes in a transaction", async () => {
    const name = crypto.randomUUID();
    const raw = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("notes", { keyPath: "id" });
        upgradeSyncDatabase(db);
      },
    });
    const tx = trackDatabase(raw).transaction("notes", "readwrite");
    await Promise.all([
      tx.store.put({ id: "a", title: "A" }),
      tx.store.put({ id: "b", title: "B" }),
    ]);
    await tx.done;
    const ops = (await raw.getAll("syncOutbox")).map(row => row.operation);
    expect(new Set(ops.map(op => op.replicaId)).size).toBe(1);
    expect(new Set(ops.map(op => op.clock)).size).toBe(2);
    raw.close();
    await deleteDB(name);
  });
  it("keeps review events and device progress alongside materialized records", async () => {
    const name = crypto.randomUUID();
    const raw = await openDB(name, 1, {
      upgrade(db) {
        for (const name of ["books", "highlights"])
          db.createObjectStore(name, { keyPath: "id" });
        upgradeSyncDatabase(db);
      },
    });
    const db = trackDatabase(raw);
    await db.put("highlights", { id: "h", review: { reps: 1 } });
    await db.put("highlights", { id: "h", review: { reps: 2 } });
    expect(await raw.count("reviews")).toBe(2);
    const events = (await raw.getAll("syncOutbox")).filter(
      e => e.operation.kind === "reviews"
    );
    expect(
      events.every(e => e.operation.operationId === e.operation.entityId)
    ).toBe(true);
    await db.put("books", {
      id: "b",
      progress: { chapterId: "c", ratio: 0.5 },
    });
    const row = await raw.get("syncEntities", "books:b");
    expect(
      Object.keys(row.state.fields).some(key => key.startsWith("@progress:"))
    ).toBe(true);
    raw.close();
    await deleteDB(name);
  });
  it("aborts the business write when an operation cannot be encoded", async () => {
    const name = crypto.randomUUID();
    const raw = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("notes", { keyPath: "id" });
        upgradeSyncDatabase(db);
      },
    });
    const db = trackDatabase(raw);
    await expect(
      db.put("notes", { id: "invalid/id", title: "must roll back" })
    ).rejects.toThrow();
    expect(await raw.count("notes")).toBe(0);
    expect(await raw.count("syncOutbox")).toBe(0);
    raw.close();
    await deleteDB(name);
  });
  it("commits edits and outbox together, rolls both back, and applies remote changes without echo", async () => {
    const name = crypto.randomUUID();
    const raw = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("notes", { keyPath: "id" });
        upgradeSyncDatabase(db);
      },
    });
    const db = trackDatabase(raw);
    await db.put("notes", {
      id: "n",
      title: "A",
      content: "one",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await raw.count("syncOutbox")).toBe(1);
    const tx = db.transaction("notes", "readwrite");
    await tx.store.put({ id: "n", title: "B", content: "two" });
    tx.abort();
    await tx.done.catch(() => undefined);
    expect((await raw.get("notes", "n")).title).toBe("A");
    expect(await raw.count("syncOutbox")).toBe(1);
    await receiveOperations(
      raw,
      [
        makeOperation(
          "unpaired",
          "peer",
          "notes",
          "n",
          { content: "remote" },
          Date.now() + 1000
        ),
      ],
      "cursor:test",
      "1"
    );
    expect((await raw.get("notes", "n")).title).toBe("A");
    expect((await raw.get("notes", "n")).content).toBe("remote");
    expect(await raw.count("syncOutbox")).toBe(1);
    raw.close();
    await deleteDB(name);
  });
});
