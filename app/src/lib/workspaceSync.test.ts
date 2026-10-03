// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto, createHash } from "node:crypto";
import { deleteDB, openDB } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOperation, applyOperation } from "@contracts/sync";
import { upgradeSyncDatabase, trackDatabase } from "./syncDatabase";

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("./db", () => ({ syncDatabase: async () => database.current }));
vi.mock("./syncPreferences", () => ({
  applyPreferences: async () => {},
  preferenceKeys: [],
}));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.resetModules();
});

describe("browser push acknowledgement", () => {
  it.each(["bootstrap", "invalid-cursor", "anti-entropy", "epoch", "restart"])(
    "recovers %s through staged network snapshots",
    async mode => {
      const name = crypto.randomUUID();
      const db = await openDB(name, 1, {
        upgrade(db) {
          db.createObjectStore("notes", { keyPath: "id" });
          db.createObjectStore("files", { keyPath: "id" });
          upgradeSyncDatabase(db);
        },
      });
      database.current = db;
      for (const id of ["projection-v1", "seeded", "seeded-files"])
        await db.put("syncMeta", { id, complete: true });
      await db.put("syncMeta", {
        id: "identity",
        workspace: "workspace",
        replica: "browser",
        clock: "1:0",
      });
      if (mode !== "bootstrap" && mode !== "restart")
        await db.put("syncMeta", {
          id: `cursor:server:${mode === "epoch" ? "old" : "epoch"}`,
          cursor: "start",
          snapshotAt: mode === "anti-entropy" ? 0 : Date.now(),
        });
      const local = {
        id: "local",
        title: "local",
        content: "keep",
        createdAt: 1,
        updatedAt: 1,
      };
      await trackDatabase(db).put("notes", local);
      const pending = await db.getAll("syncOutbox");
      const remote = applyOperation(
        undefined,
        makeOperation(
          "workspace",
          "server",
          "notes",
          "remote",
          { title: "remote", content: "\ud800", createdAt: 1, updatedAt: 1 },
          5
        )
      );
      let invalid = mode === "invalid-cursor";
      let fail = mode === "restart";
      let snapshots = 0;
      const pushed: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string, init?: RequestInit) => {
          if (path.endsWith("/capabilities"))
            return Response.json({
              version: 2,
              workspaceId: "workspace",
              nodeId: "server",
              epoch: "epoch",
            });
          if (path.includes("/sync/changes")) {
            if (invalid) {
              invalid = false;
              return Response.json(
                { error: "invalid_cursor" },
                { status: 400 }
              );
            }
            return Response.json({
              operations: [],
              cursor: "after-snapshot",
              hasMore: false,
            });
          }
          if (path.endsWith("/sync/snapshots")) {
            snapshots++;
            return Response.json({ id: "snapshot", cursor: "watermark" });
          }
          if (path.includes("/sync/snapshots/snapshot")) {
            if (path.endsWith("after="))
              return Response.json({
                entities: [remote],
                next: "notes:remote",
                cursor: "watermark",
              });
            if (fail) {
              fail = false;
              throw new Error("injected_disconnect");
            }
            return Response.json({
              entities: [],
              next: null,
              cursor: "watermark",
            });
          }
          if (path.endsWith("/sync/push")) {
            const payload = JSON.parse(init!.body as string);
            pushed.push(payload.operations);
            return Response.json({
              receipts: payload.operations.map(
                (operation: { operationId: string }) => ({
                  operationId: operation.operationId,
                  seq: "1",
                })
              ),
            });
          }
          throw new Error(`Unexpected request ${path}`);
        })
      );
      try {
        let sync = await import("./workspaceSync");
        if (mode === "restart") {
          await expect(sync.trySyncWorkspace()).rejects.toThrow(
            "injected_disconnect"
          );
          expect(await db.get("notes", "remote")).toBeUndefined();
          expect(await db.getAll("syncOutbox")).toEqual(pending);
          vi.resetModules();
          sync = await import("./workspaceSync");
        }
        await expect(sync.trySyncWorkspace()).resolves.toBe(true);
        expect(snapshots).toBe(1);
        expect(await db.get("notes", "remote")).toMatchObject({
          content: "\ud800",
        });
        expect(await db.get("notes", "local")).toEqual(local);
        expect(pushed).toEqual(pending.map(row => [row.operation]));
        expect((await db.get("syncMeta", "cursor:server:epoch")).cursor).toBe(
          "after-snapshot"
        );
        expect(
          (await db.getAll("syncMeta")).some(row =>
            row.id.startsWith("snapshot-page:")
          )
        ).toBe(false);
      } finally {
        db.close();
        await deleteDB(name);
      }
    }
  );
  it.each(["receipts", "commit", "progress"])(
    "uploads committed field bytes and retries the exact original operation after failed %s",
    async mode => {
      vi.stubGlobal("crypto", webcrypto);
      const name = crypto.randomUUID();
      const db = await openDB(name, 1, {
        upgrade(db) {
          db.createObjectStore("notes", { keyPath: "id" });
          db.createObjectStore("files", { keyPath: "id" });
          upgradeSyncDatabase(db);
        },
      });
      database.current = db;
      for (const id of ["projection-v1", "seeded", "seeded-files"])
        await db.put("syncMeta", { id, complete: true });
      await db.put("syncMeta", {
        id: "identity",
        workspace: "workspace",
        replica: "browser",
        clock: "1:0",
      });
      await db.put("syncMeta", {
        id: "cursor:server:epoch",
        cursor: "start",
        snapshotAt: Date.now(),
      });
      const note = {
        id: "large",
        title: "note",
        content: "大\ud800".repeat(40000),
        createdAt: 1,
        updatedAt: 1,
      };
      await trackDatabase(db).put("notes", note);
      const original = (await db.getAll("syncOutbox"))[0];
      const reference = original.operation.patch.content.$blob;
      const field = await db.get("syncMeta", `field:${reference.sha256}`);
      const uploaded = new Map<number, ArrayBuffer>();
      const pushed: unknown[] = [];
      let commits = 0;
      let statusRequests = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string, init?: RequestInit) => {
          if (path.endsWith("/capabilities"))
            return Response.json({
              version: 2,
              workspaceId: "workspace",
              nodeId: "server",
              epoch: "epoch",
            });
          if (path.includes("/sync/changes"))
            return Response.json({
              operations: [],
              cursor: "next",
              hasMore: false,
            });
          if (path.endsWith("/blobs/uploads"))
            return Response.json({ id: "upload" });
          if (path.endsWith("/blobs/uploads/upload")) {
            statusRequests++;
            return Response.json({
              manifest: reference,
              missing:
                mode === "progress" && statusRequests === 1
                  ? [1024]
                  : [0, 1].filter(i => !uploaded.has(i)),
            });
          }
          if (/\/blobs\/uploads\/upload\/\d+$/.test(path)) {
            const part = init!.body as ArrayBuffer;
            expect(
              (init!.headers as Record<string, string>)["X-Chunk-SHA256"]
            ).toBe(
              createHash("sha256").update(new Uint8Array(part)).digest("hex")
            );
            uploaded.set(Number(path.split("/").at(-1)), part);
            return Response.json({ ok: true });
          }
          if (path.endsWith("/commit")) {
            commits++;
            return Response.json(
              mode === "commit" && commits === 1
                ? { ...reference, sha256: "0".repeat(64) }
                : reference
            );
          }
          if (path.endsWith("/sync/push")) {
            pushed.push(JSON.parse(init!.body as string));
            return Response.json({
              receipts:
                mode === "receipts" && pushed.length === 1
                  ? []
                  : [{ operationId: original.id, seq: "1" }],
            });
          }
          if (path.endsWith(`/blobs/${reference.sha256}`))
            return new Response(field.bytes);
          throw new Error(`Unexpected request ${path}`);
        })
      );
      try {
        const { trySyncWorkspace } = await import("./workspaceSync");
        await expect(trySyncWorkspace()).rejects.toThrow(
          mode === "receipts"
            ? "invalid_sync_receipts"
            : mode === "progress"
              ? "invalid_upload_progress"
              : "invalid_upload_acknowledgement"
        );
        expect(await db.get("syncOutbox", original.id)).toEqual(original);
        await expect(trySyncWorkspace()).resolves.toBe(true);
        expect(pushed).toEqual(
          Array.from({ length: mode === "receipts" ? 2 : 1 }, () => ({
            operations: [original.operation],
          }))
        );
        expect(uploaded.size).toBe(2);
        expect(await db.count("syncOutbox")).toBe(0);
        expect(
          (await db.get("syncEntities", "notes:large")).state.fields.content
            .value
        ).toEqual({ $blob: reference });
        expect(await db.get("notes", "large")).toEqual(note);
      } finally {
        db.close();
        await deleteDB(name);
      }
    }
  );
  it.each([
    "missing",
    "wrong-id",
    "not-persisted",
    "invalid-sequence",
    "legacy",
    "current",
  ])(
    "retains the original queue until %s receipts are accepted",
    async mode => {
      const name = crypto.randomUUID();
      const db = await openDB(name, 1, {
        upgrade(db) {
          db.createObjectStore("files", { keyPath: "id" });
          upgradeSyncDatabase(db);
        },
      });
      database.current = db;
      const operation = makeOperation(
        "workspace",
        "browser",
        "notes",
        "note",
        { title: "keep" },
        1
      );
      await db.put("syncOutbox", { id: operation.operationId, operation });
      for (const id of ["projection-v1", "seeded", "seeded-files"])
        await db.put("syncMeta", { id, complete: true });
      await db.put("syncMeta", {
        id: "identity",
        workspace: "workspace",
        replica: "browser",
        clock: "1:0",
      });
      await db.put("syncMeta", {
        id: "cursor:server:epoch",
        cursor: "start",
        snapshotAt: Date.now(),
      });
      const valid = {
        operationId: operation.operationId,
        seq: "1",
        duplicate: false,
      };
      const receipts =
        mode === "missing"
          ? []
          : [
              {
                ...valid,
                ...(mode === "wrong-id" ? { operationId: "other" } : {}),
                ...(mode === "not-persisted" ? { persisted: false } : {}),
                ...(mode === "invalid-sequence" ? { seq: "0" } : {}),
                ...(mode === "current" ? { persisted: true } : {}),
              },
            ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string) => {
          if (path.endsWith("/capabilities"))
            return Response.json({
              version: 2,
              workspaceId: "workspace",
              nodeId: "server",
              epoch: "epoch",
            });
          if (path.includes("/sync/changes"))
            return Response.json({
              operations: [],
              cursor: "next",
              hasMore: false,
            });
          if (path.endsWith("/sync/push")) return Response.json({ receipts });
          throw new Error(`Unexpected request ${path}`);
        })
      );
      try {
        const { trySyncWorkspace } = await import("./workspaceSync");
        if (["legacy", "current"].includes(mode)) {
          await expect(trySyncWorkspace()).resolves.toBe(true);
          expect(await db.count("syncOutbox")).toBe(0);
        } else {
          await expect(trySyncWorkspace()).rejects.toThrow();
          expect(await db.get("syncOutbox", operation.operationId)).toEqual({
            id: operation.operationId,
            operation,
          });
        }
      } finally {
        db.close();
        await deleteDB(name);
      }
    }
  );
});
