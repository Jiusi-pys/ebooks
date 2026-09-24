import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Book } from "@/types";
import {
  acknowledgeReaderState,
  deleteBook,
  getAllBooks,
  getFile,
  patchBookProgress,
  pendingReaderStates,
  putBook,
  cacheServerBook,
  putImportedBook,
} from "./db";
import {
  synchronizeLibrary,
  flushReaderStates,
  syncBrowserToMySql,
  syncMySqlToBrowser,
  syncMySqlMirrorToBrowser,
} from "./librarySync";
import { syncBookMirror } from "./mirrorSync";

vi.mock("./mirrorSync", () => ({
  syncBookMirror: vi.fn(),
  deliverMirrorEvent: vi.fn(),
}));
const book: Book = {
  id: "sync-test",
  title: "Cloud PDF",
  author: "A",
  format: "pdf",
  coverTone: 2,
  createdAt: 1,
  chapters: [{ id: "c1", title: "One", paragraphs: ["Text"] }],
  progress: { chapterId: "c1", ratio: 0.7 },
  readerMode: "original",
  outline: [{ id: "o1", title: "One", chapterId: "c1", depth: 0 }],
};
afterEach(async () => {
  await deleteBook(book.id);
  await deleteBook("mysql-only");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("server-backed library", () => {
  it("uploads browser books without reading a MySQL book back into the cache", async () => {
    await putBook(book);
    const fetchMock = vi.fn(async (path: string) => {
      if (path.endsWith("/books"))
        return Response.json({
          books: [{ id: book.id, hasReaderData: true, source: null }],
          deletedBookIds: [],
          folders: [],
        });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncBrowserToMySql();

    expect(syncBookMirror).toHaveBeenCalledWith(
      expect.objectContaining({ extId: book.id })
    );
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain(
      `/api/library/books/${book.id}`
    );
  });

  it("downloads MySQL books without uploading browser content", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path.endsWith(`/books/${book.id}`))
        return Response.json({ book, source: null });
      return Response.json({
        books: [{ id: book.id, hasReaderData: true, source: null }],
        deletedBookIds: [],
        folders: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMySqlToBrowser();

    expect(await getAllBooks()).toContainEqual(book);
    expect(syncBookMirror).not.toHaveBeenCalled();
  });

  it("removes browser-only books when mirroring the MySQL catalog", async () => {
    const remoteBook = { ...book, id: "mysql-only", title: "MySQL book" };
    await putBook(book);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.endsWith("/books/mysql-only"))
          return Response.json({ book: remoteBook, source: null });
        return Response.json({
          books: [{ id: remoteBook.id, hasReaderData: true, source: null }],
          deletedBookIds: [book.id],
          folders: [],
        });
      })
    );

    await syncMySqlMirrorToBrowser();

    expect(await getAllBooks()).toEqual([remoteBook]);
  });

  it("retains browser-only books when merging the MySQL catalog", async () => {
    const remoteBook = { ...book, id: "mysql-only", title: "MySQL book" };
    await putBook(book);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.endsWith("/books/mysql-only"))
          return Response.json({ book: remoteBook, source: null });
        return Response.json({
          books: [{ id: remoteBook.id, hasReaderData: true, source: null }],
          deletedBookIds: [],
          folders: [],
        });
      })
    );

    await syncMySqlToBrowser();

    expect(await getAllBooks()).toHaveLength(2);
  });

  it("migrates a local-only book and uploads its complete source in bounded chunks", async () => {
    const bytes = new Uint8Array(300 * 1024).fill(42);
    await putImportedBook(book, {
      id: book.id,
      type: "pdf",
      name: "legacy.pdf",
      data: bytes.buffer,
    });
    const chunks: { index: number; payload: string }[] = [];
    let manifest: unknown;
    let readerState: unknown;
    const remoteBook = { id: book.id, hasReaderData: true, source: null };
    let catalogReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith("/chunks"))
          chunks.push(JSON.parse(init!.body as string));
        if (path.endsWith("/complete"))
          manifest = JSON.parse(init!.body as string);
        if (path.endsWith("/state"))
          readerState = JSON.parse(init!.body as string);
        if (path.endsWith("/books"))
          return Response.json({
            books: catalogReads++ ? [remoteBook] : [],
            deletedBookIds: [],
            folders: [],
          });
        if (path.endsWith(`/${book.id}`))
          return Response.json({ book, source: manifest });
        return Response.json({ ok: true });
      })
    );
    await synchronizeLibrary();
    expect(syncBookMirror).toHaveBeenCalledWith(
      expect.objectContaining({ extId: book.id, chapters: book.chapters })
    );
    expect(readerState).toMatchObject({
      progress: book.progress,
      outline: book.outline,
    });
    expect(chunks.map(chunk => chunk.index)).toEqual([0, 1]);
    expect(
      Buffer.concat(chunks.map(chunk => Buffer.from(chunk.payload, "base64")))
    ).toEqual(Buffer.from(bytes));
    expect(manifest).toMatchObject({
      size: bytes.length,
      chunks: 2,
      name: "legacy.pdf",
    });
  });
  it("restores a complete book and byte-identical original into an empty browser", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 test source");
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      b => b.toString(16).padStart(2, "0")
    ).join("");
    const source = {
      uploadId: sha256,
      sha256,
      size: bytes.length,
      chunks: 1,
      name: "book.pdf",
      type: "application/pdf",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.endsWith("/source")) return new Response(bytes);
        if (path.endsWith(`/${book.id}`))
          return Response.json({ book, source });
        return Response.json({
          books: [{ id: book.id, hasReaderData: true, source }],
          deletedBookIds: [],
          folders: [],
        });
      })
    );
    await synchronizeLibrary();
    expect(await getAllBooks()).toContainEqual(book);
    const file = await getFile(book.id);
    expect(file?.name).toBe("book.pdf");
    expect(new Uint8Array(await (file!.data as Blob).arrayBuffer())).toEqual(
      bytes
    );
  });

  it("keeps offline progress pending after failure and retries it", async () => {
    await putBook(book);
    await patchBookProgress(book.id, "c1", 0.9);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ ok: true }))
    );
    await expect(flushReaderStates()).rejects.toThrow("503");
    expect(await pendingReaderStates()).toHaveLength(1);
    await flushReaderStates();
    expect(await pendingReaderStates()).toHaveLength(0);
  });

  it("does not acknowledge a newer edit or overwrite it during cache restoration", async () => {
    await putBook(book);
    await patchBookProgress(book.id, "c1", 0.8);
    const [old] = await pendingReaderStates();
    await patchBookProgress(book.id, "c1", 0.95);
    await acknowledgeReaderState(old);
    expect(await pendingReaderStates()).toHaveLength(1);
    await cacheServerBook(book);
    expect((await getAllBooks())[0].progress.ratio).toBe(0.95);
  });

  it("removes tombstoned local books and their queued state instead of resurrecting them", async () => {
    await putBook(book);
    await patchBookProgress(book.id, "c1", 0.9);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ books: [], deletedBookIds: [book.id], folders: [] })
      )
    );
    await synchronizeLibrary();
    expect(await getAllBooks()).toHaveLength(0);
    expect(await pendingReaderStates()).toHaveLength(0);
  });
});
