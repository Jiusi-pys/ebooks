import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Book } from "@/types";
import {
  closeDatabaseConnection,
  putImportedBook,
  SHUFANG_DB_NAME,
  syncDatabase,
} from "./db";

async function reset() {
  closeDatabaseConnection();
  await deleteDB(SHUFANG_DB_NAME);
}
beforeEach(reset);
afterEach(reset);

const book: Book = {
  id: "source-import",
  title: "Import regression",
  author: "",
  format: "epub",
  coverTone: 0,
  chapters: [{ id: "chapter", title: "Chapter", paragraphs: ["Body"] }],
  createdAt: 1,
  progress: { chapterId: "chapter", ratio: 0 },
};

it.each(["File", "Blob", "ArrayBuffer"] as const)(
  "atomically imports %s source bytes and manifest",
  async kind => {
    const bytes = new Uint8Array([1, 2, 3]);
    const type = "application/epub+zip";
    const data =
      kind === "File"
        ? new File([bytes], "book.epub", { type })
        : kind === "Blob"
          ? new Blob([bytes], { type })
          : bytes.buffer;
    await putImportedBook(book, {
      id: book.id,
      type: "epub",
      name: "book.epub",
      data,
    });
    const db = await syncDatabase();
    expect(await db.get("books", book.id)).toEqual(book);
    expect(await db.get("sources", book.id)).toMatchObject({
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      type: kind === "ArrayBuffer" ? "application/octet-stream" : type,
    });
    const stored = (await db.get("files", book.id)).data;
    expect(
      new Uint8Array(stored instanceof Blob ? await stored.arrayBuffer() : stored)
    ).toEqual(bytes);
    expect(
      (await db.getAll("syncOutbox")).map(row => row.operation.kind).sort()
    ).toEqual(["books", "sources"]);
  }
);

it("rejects a spoofed File without leaving partial book or source records", async () => {
  const data = {
    [Symbol.toStringTag]: "File",
    size: 3,
    type: "application/epub+zip",
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Blob;
  await expect(
    putImportedBook(book, { id: book.id, type: "epub", data })
  ).rejects.toThrow();
  const db = await syncDatabase();
  for (const store of ["books", "files", "sources", "syncOutbox"] as const)
    expect(await db.count(store)).toBe(0);
});
