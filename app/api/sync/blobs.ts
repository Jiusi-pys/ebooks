import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  readdir,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { SyncError } from "./store";
import { digest } from "./store";

export const blobManifest = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .min(0)
    .max(256 * 1024 * 1024),
  name: z.string().max(255),
  type: z.string().max(128),
});
export type BlobManifest = z.infer<typeof blobManifest>;
export const chunkSize = 256 * 1024;
export class BlobStore {
  root: string;
  private commits = new Map<string, Promise<BlobManifest>>();
  constructor(root: string) {
    this.root = resolve(root);
  }
  path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new SyncError("invalid_hash");
    return join(this.root, "objects", hash);
  }
  session(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new SyncError("invalid_upload_id");
    return join(this.root, "uploads", id);
  }
  async has(hash: string) {
    return stat(this.path(hash)).then(
      () => true,
      () => false
    );
  }
  private legacyPath(bookId: string, hash: string) {
    this.path(hash);
    return join(this.root, "legacy", digest(bookId), hash);
  }
  async stageLegacy(
    bookId: string,
    hash: string,
    index: number,
    bytes: Buffer
  ) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 1024 ||
      bytes.length > chunkSize
    )
      throw new SyncError("invalid_chunk");
    const directory = this.legacyPath(bookId, hash);
    await mkdir(directory, { recursive: true });
    const path = join(directory, String(index));
    const prior = await readFile(path).catch(() => undefined);
    if (prior) {
      if (!prior.equals(bytes)) throw new SyncError("chunk_id_reused", 409);
      return;
    }
    await writeFile(path, bytes, { flag: "wx" });
  }
  async completeLegacy(bookId: string, manifest: BlobManifest) {
    const session = await this.create(manifest);
    if (!session.present) {
      for (let i = 0; i < session.chunks; i++) {
        const bytes = await readFile(
          join(this.legacyPath(bookId, manifest.sha256), String(i))
        ).catch(() => {
          throw new SyncError("missing_chunks", 409);
        });
        await this.put(session.id, i, bytes, digest(bytes));
      }
    }
    return this.commit(session.id);
  }
  async create(input: unknown) {
    const manifest = blobManifest.parse(input);
    const id = randomUUID();
    await mkdir(this.session(id), { recursive: true });
    await writeFile(
      join(this.session(id), "manifest.json"),
      JSON.stringify(manifest),
      { flag: "wx" }
    );
    return {
      id,
      chunkSize,
      chunks: Math.ceil(manifest.size / chunkSize),
      present: await this.has(manifest.sha256),
    };
  }
  async manifest(id: string): Promise<BlobManifest> {
    try {
      return blobManifest.parse(
        JSON.parse(
          await readFile(join(this.session(id), "manifest.json"), "utf8")
        )
      );
    } catch {
      throw new SyncError("upload_not_found", 404);
    }
  }
  async status(id: string) {
    const manifest = await this.manifest(id);
    if (await this.has(manifest.sha256))
      return { manifest, missing: [] as number[] };
    const names = new Set(await readdir(this.session(id)));
    return {
      manifest,
      missing: Array.from(
        { length: Math.ceil(manifest.size / chunkSize) },
        (_, i) => i
      ).filter(i => !names.has(String(i))),
    };
  }
  async put(id: string, index: number, bytes: Buffer, hash: string) {
    const manifest = await this.manifest(id);
    const count = Math.ceil(manifest.size / chunkSize);
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new SyncError("invalid_chunk");
    const expected = Math.min(chunkSize, manifest.size - index * chunkSize);
    if (
      bytes.length !== expected ||
      createHash("sha256").update(bytes).digest("hex") !== hash
    )
      throw new SyncError("chunk_checksum_mismatch", 422);
    const tmp = join(this.session(id), `${index}.${randomUUID()}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, join(this.session(id), String(index)));
  }
  commit(id: string): Promise<BlobManifest> {
    let result = this.commits.get(id);
    if (!result) {
      result = this.commitOnce(id).finally(() => this.commits.delete(id));
      this.commits.set(id, result);
    }
    return result;
  }
  private async commitOnce(id: string) {
    const existing = await this.manifest(id);
    if (await this.has(existing.sha256)) return existing;
    const { manifest, missing } = await this.status(id);
    if (missing.length) throw new SyncError("missing_chunks", 409);
    await mkdir(join(this.root, "objects"), { recursive: true });
    const tmp = join(
      this.root,
      "objects",
      `${manifest.sha256}.${randomUUID()}.tmp`
    );
    const hash = createHash("sha256");
    let size = 0;
    const directory = this.session(id);
    async function* chunks() {
      for (let i = 0; i < Math.ceil(manifest.size / chunkSize); i++) {
        for await (const piece of createReadStream(
          join(directory, String(i))
        )) {
          hash.update(piece);
          size += piece.length;
          yield piece;
        }
      }
    }
    await pipeline(
      Readable.from(chunks()),
      createWriteStream(tmp, { flags: "wx" })
    );
    if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) {
      await rm(tmp, { force: true });
      throw new SyncError("file_checksum_mismatch", 422);
    }
    if (!(await this.has(manifest.sha256)))
      await rename(tmp, this.path(manifest.sha256));
    else await rm(tmp, { force: true });
    for (let i = 0; i < Math.ceil(manifest.size / chunkSize); i++)
      await rm(join(this.session(id), String(i)), { force: true });
    return manifest;
  }
}
