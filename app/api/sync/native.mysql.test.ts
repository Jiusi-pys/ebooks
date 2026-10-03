import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SyncStore, digest } from "./store";
import { BlobStore, chunkSize } from "./blobs";
import { createSyncApi } from "./api";
import { makeOperation, materialize } from "../../contracts/sync";

const databaseUrl = process.env.NATIVE_SYNC_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("real legacy MySQL/v2 and native SQLite", () => {
  it("exchanges notes, retries IDs and transfers legacy source chunks over HTTP", async () => {
    const workspace = `native-sync-${randomUUID()}`;
    const store = new SyncStore(databaseUrl!, workspace, "legacy");
    const directory = await mkdtemp(join(tmpdir(), "native-sync-mixed-"));
    const blobs = new BlobStore(directory);
    const linuxEnabled = process.env.NATIVE_SYNC_TEST_LINUX === "1";
    const linuxName = `shufang-native-sync-runtime-${randomUUID()}`;
    let linuxStarted = false;
    let linuxOrigin = "";
    const linuxToken = "isolated-linux-owner-token-at-least-32-chars";
    let close: (() => Promise<void>) | undefined;
    try {
      await store.initialize();
      await store.accept(
        makeOperation(
          workspace,
          "legacy",
          "notes",
          "legacy-note",
          { title: "Legacy", content: "old-v2", createdAt: 1, updatedAt: 1 },
          1
        )
      );
      const bytes = Buffer.alloc(chunkSize + 17, 37);
      const manifest = {
        sha256: digest(bytes),
        size: bytes.length,
        name: "book.txt",
        type: "text/plain",
      };
      const upload = await blobs.create(manifest);
      for (let index = 0; index < upload.chunks; index++) {
        const chunk = bytes.subarray(
          index * chunkSize,
          (index + 1) * chunkSize
        );
        await blobs.put(upload.id, index, chunk, digest(chunk));
      }
      await blobs.commit(upload.id);
      await store.accept(
        makeOperation(workspace, "legacy", "sources", "source", manifest, 2)
      );
      // Scoped node credential; no browser/admin authentication is needed.
      const token = randomUUID() + randomUUID();
      await store.pool.query(
        "INSERT INTO sync_credentials (workspace,credential_id,digest) VALUES (?,?,?)",
        [workspace, "native", digest(token)]
      );
      const app = new Hono().route("/api/v2", createSyncApi(store, blobs).api);
      const server = serve({
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
      });
      await new Promise<void>(done =>
        server.listening ? done() : server.once("listening", done)
      );
      close = () =>
        new Promise<void>((done, reject) =>
          server.close(error => (error ? reject(error) : done()))
        );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing test port");
      if (linuxEnabled) {
        await promisify(execFile)("docker", [
          "run",
          "--name",
          linuxName,
          "--detach",
          "--publish",
          "127.0.0.1::31417",
          "--mount",
          "type=volume,source=shufang-native-sync-target,target=/work/target,readonly",
          "--env",
          `SHUFANG_SERVICE_TOKEN=${linuxToken}`,
          "rust:1.93.1-slim",
          "/work/target/release/shufang-service",
          "--workspace",
          "/tmp/isolated-library",
          "--workspace-id",
          workspace,
          "--node-id",
          "linux",
          "--listen",
          "0.0.0.0",
        ]);
        linuxStarted = true;
        const { stdout } = await promisify(execFile)("docker", [
          "port",
          linuxName,
          "31417/tcp",
        ]);
        const port = stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
        if (!port) throw new Error("missing Linux test port");
        linuxOrigin = `http://127.0.0.1:${port}`;
        const headers = {
          Authorization: `Bearer ${linuxToken}`,
          "Content-Type": "application/json",
        };
        let ready = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            const response = await fetch(`${linuxOrigin}/api/v2/capabilities`, {
              headers,
            });
            if (response.ok) {
              ready = true;
              break;
            }
          } catch {
            /* Service still starting. */
          }
          await new Promise(done => setTimeout(done, 100));
        }
        expect(ready).toBe(true);
        const created = await fetch(`${linuxOrigin}/api/v1/notes`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            extId: "linux-note",
            title: "Linux",
            content: "linux-runtime",
          }),
        });
        expect(created.status).toBe(201);
      }
      await promisify(execFile)(
        process.env.CARGO ?? "cargo",
        [
          "test",
          "--manifest-path",
          resolve("../base/Cargo.toml"),
          "-p",
          "shufang-service",
          "--test",
          "old_v2",
          "--release",
          "--locked",
          "--",
          "--ignored",
        ],
        {
          timeout: 120_000,
          env: {
            ...process.env,
            ...(linuxEnabled
              ? {
                  SHUFANG_LINUX_TEST_ORIGIN: linuxOrigin,
                  SHUFANG_LINUX_TEST_TOKEN: linuxToken,
                }
              : {}),
            SHUFANG_OLD_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
            SHUFANG_OLD_TEST_WORKSPACE: workspace,
            SHUFANG_OLD_TEST_TOKEN: token,
            SHUFANG_OLD_TEST_BLOB_HASH: manifest.sha256,
          },
        }
      ).catch((error: { stdout?: string }) => {
        throw new Error(error.stdout ?? "native integration failed");
      });
      const rows = (await store.entities("notes")).entities.map(materialize);
      expect(rows.find(row => row?.id === "native-note")?.content).toBe(
        "shared rules"
      );
      expect((await store.changes()).operations).toHaveLength(
        linuxEnabled ? 5 : 4
      );
      if (linuxEnabled) {
        expect(rows.find(row => row?.id === "linux-note")?.content).toBe(
          "linux-runtime"
        );
        const response = await fetch(
          `${linuxOrigin}/api/v2/blobs/${manifest.sha256}`,
          { headers: { Authorization: `Bearer ${linuxToken}` } }
        );
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      }
    } finally {
      if (linuxStarted)
        await promisify(execFile)("docker", ["rm", "--force", linuxName]);
      await close?.();
      for (const table of [
        "sync_operations",
        "sync_entities",
        "sync_cursors",
        "sync_credentials",
        "sync_heads",
      ])
        await store.pool.query(`DELETE FROM ${table} WHERE workspace=?`, [
          workspace,
        ]);
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 150_000);
});
