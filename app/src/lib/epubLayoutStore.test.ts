import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "@/types";
import type { EpubLayout } from "./epubLayout";
import {
  cacheServerBook,
  closeDatabaseConnection,
  deleteBook,
  deleteFile,
  putFile,
  putImportedBook,
  SHUFANG_DB_NAME,
  SHUFANG_DB_VERSION,
  syncDatabase,
} from "./db";
import { receiveOperations, receiveSnapshot } from "./syncDatabase";
import { beginSnapshot, finishSnapshot, stageSnapshot } from "./syncSnapshots";
import { applyOperation, makeOperation } from "@contracts/sync";

const key = (id: string) => `epub-layout:${id}`;
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42AAAAAASUVORK5CYII=";
const book = (id = "book"): Book => ({
  id,
  title: "Book",
  author: "",
  format: "epub",
  coverTone: 0,
  chapters: [
    {
      id: "chapter",
      title: "Chapter",
      paragraphs: ["Body[1]"],
      footnotes: [{ paraIndex: 0, start: 4, end: 7, content: "Note" }],
    },
  ],
  createdAt: 1,
  progress: { chapterId: "chapter", ratio: 0 },
});
const layout = (): EpubLayout => ({
  version: 1,
  assets: {
    image: { dataUrl: png, mediaType: "image/png", width: 1, height: 1 },
  },
  chapters: { chapter: { items: [{ kind: "paragraph", paraIndex: 0 }] } },
});
const file = (id = "book", bytes = [1, 2, 3]) => ({
  id,
  type: "epub" as const,
  name: "book.epub",
  data: new Uint8Array(bytes).buffer,
});
const getLayout = async (value: Book) =>
  (await import("./epubLayoutStore")).getEpubLayout(value);
async function reset() {
  closeDatabaseConnection();
  await deleteDB(SHUFANG_DB_NAME);
}
beforeEach(reset);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe("local EPUB layout storage", () => {
  it("imports browser File data without converting the caller's file to an ArrayBuffer", async () => {
    const data = new File([new Uint8Array([1, 2, 3])], "browser.epub", {
      type: "application/epub+zip",
    });
    await putImportedBook(book(), { ...file(), data }, layout());
    const db = await syncDatabase();
    expect(await getLayout(book())).toEqual(layout());
    expect(await db.get("sources", "book")).toMatchObject({
      size: 3,
      type: "application/epub+zip",
    });
    expect(Object.prototype.toString.call(data)).toBe("[object File]");
  });

  it("rejects a fake File brand before any import writes", async () => {
    const data = {
      [Symbol.toStringTag]: "File",
      size: 3,
      type: "application/epub+zip",
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Blob;
    await expect(
      putImportedBook(book(), { ...file(), data }, layout())
    ).rejects.toThrow();
    expect(await (await syncDatabase()).count("books")).toBe(0);
  });

  it.each([
    "empty",
    "partial",
    "missing-chapter",
    "unknown-chapter",
    "duplicate",
  ])(
    "falls back to original text and refuses imports for %s paragraph coverage",
    async defect => {
      const original = book();
      original.chapters[0].paragraphs.push("SECOND");
      const complete = layout();
      complete.chapters.chapter.items.push({
        kind: "figure",
        items: [{ kind: "paragraph", paraIndex: 1 }],
      });
      await putImportedBook(original, file(), complete);
      expect(await getLayout(original)).toEqual(complete);
      const broken = structuredClone(complete);
      if (defect === "empty") broken.chapters.chapter.items = [];
      if (defect === "partial") broken.chapters.chapter.items.pop();
      if (defect === "missing-chapter") broken.chapters = {};
      if (defect === "unknown-chapter")
        broken.chapters = { unknown: broken.chapters.chapter };
      if (defect === "duplicate")
        broken.chapters.chapter.items.push({ kind: "paragraph", paraIndex: 0 });
      const db = await syncDatabase();
      await db.put("metadata", {
        ...(await db.get("metadata", key(original.id))),
        layout: broken,
      });
      expect(await getLayout(original)).toBeUndefined();
      expect((await db.get("books", original.id)).chapters).toEqual(
        original.chapters
      );
      await expect(putImportedBook(original, file(), broken)).rejects.toThrow(
        "invalid_epub_layout"
      );
    }
  );

  it("accepts a fully represented image-only chapter with no legacy paragraphs", async () => {
    const original = book();
    original.chapters[0].paragraphs = [];
    original.chapters[0].footnotes = [];
    const images = layout();
    images.chapters.chapter.items = [
      { kind: "image", assetId: "image", alt: "Illustration" },
    ];
    await putImportedBook(original, file(), images);
    expect(await getLayout(original)).toEqual(images);
  });

  it("does not report a committed import as failed when cross-tab notifications are unavailable", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("channel unavailable");
        }
      }
    );
    await expect(
      putImportedBook(book(), file(), layout())
    ).resolves.toBeUndefined();
    expect(await getLayout(book())).toEqual(layout());
  });

  it("commits book, source and layout atomically without putting assets in operations", async () => {
    const original = book();
    await putImportedBook(original, file(), layout());
    const db = await syncDatabase();
    expect(await getLayout(original)).toEqual(layout());
    expect(await db.get("books", original.id)).toEqual(original);
    expect((await db.get("metadata", key(original.id))).sourceSha256).toBe(
      (await db.get("sources", original.id)).sha256
    );
    const operations = await db.getAll("syncOutbox");
    expect(operations.map(row => row.operation.kind).sort()).toEqual([
      "books",
      "sources",
    ]);
    expect(JSON.stringify(operations)).not.toContain(png);
    expect(JSON.stringify(operations)).not.toContain("epub-layout");
    expect(db.version).toBe(SHUFANG_DB_VERSION);
    closeDatabaseConnection();
    expect(await getLayout(original)).toEqual(layout());
  });

  it("rolls back book, file, source and outbox when layout persistence fails", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      id
    ) {
      if (this.name === "metadata" && value.key === key("book"))
        throw new DOMException("layout quota", "QuotaExceededError");
      return originalPut.call(this, value, id);
    });
    await expect(putImportedBook(book(), file(), layout())).rejects.toThrow(
      "layout quota"
    );
    const db = await syncDatabase();
    for (const store of [
      "books",
      "files",
      "sources",
      "syncOutbox",
      "syncEntities",
    ])
      expect(await db.count(store), store).toBe(0);
    expect(await db.get("metadata", key("book"))).toBeUndefined();
  });

  it("retains old import calls and rejects layout without an EPUB source", async () => {
    await putImportedBook(book());
    expect(await getLayout(book())).toBeUndefined();
    await expect(
      putImportedBook(book("no-source"), undefined, layout())
    ).rejects.toThrow();
    await expect(
      putImportedBook(
        { ...book("pdf"), format: "pdf" },
        { ...file("pdf"), type: "pdf" },
        layout()
      )
    ).rejects.toThrow();
  });

  it("preserves layout through catalogue and reading-state updates, rejects caller mismatch", async () => {
    const original = book();
    await putImportedBook(original, file(), layout());
    const updated = {
      ...original,
      title: "Renamed",
      progress: { chapterId: "chapter", ratio: 0.8 },
      metadata: { version: 1 as const, publisher: "Publisher" },
    };
    await cacheServerBook(updated);
    expect(await getLayout(updated)).toEqual(layout());
    const mismatch = structuredClone(updated);
    mismatch.chapters[0].footnotes![0].content = "changed";
    expect(await getLayout(mismatch)).toBeUndefined();
    expect(await getLayout({ ...updated, id: "another" })).toBeUndefined();
  });

  it("clears layout when cached chapters or notes change, despite an unchanged contentHash", async () => {
    const original = { ...book(), contentHash: "unchanged" };
    await putImportedBook(original, file(), layout());
    const updated = structuredClone(original);
    updated.chapters[0].footnotes![0].content = "new note";
    await cacheServerBook(updated);
    expect(await getLayout(updated)).toBeUndefined();
    expect(
      await (await syncDatabase()).get("metadata", key(original.id))
    ).toBeUndefined();
  });

  it("rejects a stale source or unknown sidecar version on read", async () => {
    await putImportedBook(book(), file(), layout());
    const db = await syncDatabase();
    const row = await db.get("metadata", key("book"));
    await db.put("metadata", { ...row, version: 99 });
    expect(await getLayout(book())).toBeUndefined();
    await db.put("metadata", row);
    await db.put("sources", {
      ...(await db.get("sources", "book")),
      sha256: "a".repeat(64),
    });
    expect(await getLayout(book())).toBeUndefined();
    await db.delete("books", "book");
    expect(await getLayout(book())).toBeUndefined();
  });

  it("keeps identical file bytes but clears changed sources and explicit source deletion", async () => {
    await putImportedBook(book(), file(), layout());
    await putFile({ ...file(), name: "renamed.epub" });
    expect(await getLayout(book())).toEqual(layout());
    await putFile(file("book", [3, 2, 1]));
    expect(
      await (await syncDatabase()).get("metadata", key("book"))
    ).toBeUndefined();
    await putImportedBook(book(), file(), layout());
    await deleteFile("book");
    expect(
      await (await syncDatabase()).get("metadata", key("book"))
    ).toBeUndefined();
  });

  it("retains layout when only the disposable original-file cache is evicted", async () => {
    await putImportedBook(book(), file(), layout());
    const db = await syncDatabase();
    await db.delete("files", "book");
    expect(await getLayout(book())).toEqual(layout());
  });

  it("deletes layout even if the book is already absent, without deleting unrelated metadata", async () => {
    const db = await syncDatabase();
    await db.put("metadata", { key: key("gone"), layout: layout() });
    await db.put("metadata", { key: "keep", value: "unrelated" });
    await deleteBook("gone");
    expect(await db.get("metadata", key("gone"))).toBeUndefined();
    expect(await db.get("metadata", "keep")).toEqual({
      key: "keep",
      value: "unrelated",
    });
  });
});

describe.each(["operations", "snapshot", "staged-snapshot"] as const)(
  "layout invalidation by %s",
  mode => {
    async function receive(
      kind: "books" | "sources",
      patch: Record<string, unknown>,
      deleted = false
    ) {
      const db = await syncDatabase();
      const op = {
        ...makeOperation(
          "unpaired",
          "remote",
          kind,
          "book",
          patch,
          Date.now() + 100000
        ),
        deleted,
      };
      if (mode === "operations")
        await receiveOperations(db, [op], "cursor:layout", "received");
      else {
        const prior = await db.get("syncEntities", `${kind}:book`);
        const state = applyOperation(prior?.state, op);
        if (mode === "snapshot")
          await receiveSnapshot(db, [state], {
            id: "checkpoint",
            snapshotId: "snapshot",
            after: "done",
          });
        else {
          await beginSnapshot(db, "cursor:layout", {
            id: "snapshot",
            cursor: "received",
          });
          await stageSnapshot(
            db,
            "cursor:layout",
            { cursor: "received", entities: [state], next: null },
            { after: "", pages: 0 }
          );
          await finishSnapshot(db, "cursor:layout", Date.now());
        }
      }
    }

    it("keeps same-structure projections and invalidates note changes without echo", async () => {
      await putImportedBook(book(), file(), layout());
      const db = await syncDatabase();
      const before = await db.getAll("syncOutbox");
      await receive("books", { title: "Remote name" });
      expect(await getLayout({ ...book(), title: "Remote name" })).toEqual(
        layout()
      );
      const chapters = structuredClone(book().chapters);
      chapters[0].footnotes![0].content = "remote note";
      await receive("books", { chapters });
      expect(await db.get("metadata", key("book"))).toBeUndefined();
      expect(await db.getAll("syncOutbox")).toEqual(before);
    });

    it("cleans tombstoned books and changed source hashes without echo", async () => {
      await putImportedBook(book(), file(), layout());
      const db = await syncDatabase();
      const before = await db.getAll("syncOutbox");
      await receive("sources", { sha256: "b".repeat(64) });
      expect(await db.get("metadata", key("book"))).toBeUndefined();
      await db.put("metadata", { key: key("book"), layout: layout() });
      await receive("books", {}, true);
      expect(await db.get("metadata", key("book"))).toBeUndefined();
      expect(await db.getAll("syncOutbox")).toEqual(before);
    });
  }
);
