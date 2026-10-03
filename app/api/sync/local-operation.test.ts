import { expect, it, vi } from "vitest";
import { localOperation } from "./local-operation";
import { BlobStore } from "./blobs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("publishes flattened fields before generating an operation ID and preserves UTF-16", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-fields-"));
  const blobs = new BlobStore(root);
  const original = { content: "大\ud800".repeat(40000), title: "note" };
  const completed = vi.spyOn(blobs, "commit");
  const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    // BlobStore uses node:crypto's UUID; the shared operation uses global crypto.
    expect(completed).toHaveBeenCalled();
    return "12345678-1234-1234-1234-123456789abc";
  });
  try {
    const operation = await localOperation(
      "w",
      "r",
      "notes",
      "n",
      original,
      blobs,
      1
    );
    expect(operation.patch.content).toHaveProperty("$blob");
    const hash = (operation.patch.content as { $blob: { sha256: string } })
      .$blob.sha256;
    expect(JSON.parse((await readFile(blobs.path(hash))).toString())).toBe(
      original.content
    );
    expect(original.content).toBe("大\ud800".repeat(40000));
    const members = await localOperation(
      "w",
      "r",
      "studySets",
      "set",
      { bookIds: ["a", "b"] },
      blobs,
      1
    );
    expect(members.patch).toEqual({ "@member:a": true, "@member:b": true });
  } finally {
    uuid.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
it("does not produce an operation when field publication fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-fields-failure-"));
  const blobs = new BlobStore(root);
  vi.spyOn(blobs, "commit").mockRejectedValue(new Error("disk_full"));
  const uuid = vi.spyOn(crypto, "randomUUID");
  try {
    await expect(
      localOperation(
        "w",
        "r",
        "notes",
        "n",
        { content: "x".repeat(200000) },
        blobs,
        1
      )
    ).rejects.toThrow("disk_full");
    expect(uuid).not.toHaveBeenCalled();
  } finally {
    uuid.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
