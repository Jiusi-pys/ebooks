import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, chunkSize } from "./blobs";
import { digest } from "./store";

describe("durable content addressed files", () => {
  it("does not acknowledge a corrupted existing object and can repair it", async () => {
    const root = await mkdtemp(join(tmpdir(), "shufang-sync-"));
    try {
      const bytes = Buffer.from("original");
      const store = new BlobStore(root);
      const manifest = {
        sha256: digest(bytes),
        size: bytes.length,
        name: "fixture.txt",
        type: "text/plain",
      };
      const first = await store.create(manifest);
      await store.put(first.id, 0, bytes, digest(bytes));
      await store.commit(first.id);
      await writeFile(store.path(manifest.sha256), Buffer.from("modified"));
      expect(await store.has(manifest.sha256)).toBe(false);
      const repair = await store.create(manifest);
      expect(repair.present).toBe(false);
      await expect(store.commit(repair.id)).rejects.toThrow("missing_chunks");
      await store.put(repair.id, 0, bytes, digest(bytes));
      await store.commit(repair.id);
      expect(await new BlobStore(root).has(manifest.sha256)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resumes after restart, rejects corruption and handles duplicate commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "shufang-sync-"));
    try {
      const bytes = Buffer.alloc(chunkSize * 3 + 11, 37);
      const manifest = {
        sha256: digest(bytes),
        size: bytes.length,
        name: "fixture.bin",
        type: "application/octet-stream",
      };
      const first = new BlobStore(root);
      const session = await first.create(manifest);
      await expect(
        first.put(session.id, 0, bytes.subarray(0, chunkSize), "wrong")
      ).rejects.toThrow("chunk_checksum_mismatch");
      await first.put(
        session.id,
        0,
        bytes.subarray(0, chunkSize),
        digest(bytes.subarray(0, chunkSize))
      );
      const restarted = new BlobStore(root);
      expect((await restarted.status(session.id)).missing).toEqual([1, 2, 3]);
      await expect(restarted.commit(session.id)).rejects.toThrow(
        "missing_chunks"
      );
      for (const i of [1, 2, 3]) {
        const part = bytes.subarray(i * chunkSize, (i + 1) * chunkSize);
        await restarted.put(session.id, i, part, digest(part));
      }
      expect(
        await Promise.all([
          restarted.commit(session.id),
          restarted.commit(session.id),
        ])
      ).toEqual([manifest, manifest]);
      expect((await restarted.status(session.id)).missing).toEqual([]);
      const wrong = await restarted.create({
        ...manifest,
        sha256: "0".repeat(64),
      });
      for (let i = 0; i < wrong.chunks; i++) {
        const part = bytes.subarray(i * chunkSize, (i + 1) * chunkSize);
        await restarted.put(wrong.id, i, part, digest(part));
      }
      await expect(restarted.commit(wrong.id)).rejects.toThrow(
        "file_checksum_mismatch"
      );
      expect(await restarted.has("0".repeat(64))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
