import type { Book, Folder } from "@/types";
import {
  acknowledgeReaderState,
  deleteBook,
  getAllBooks,
  getAllFolders,
  getFile,
  pendingReaderStates,
  cacheServerBook,
  putFolder,
  deleteFolder,
  type StoredFile,
} from "./db";
import { syncBookMirror } from "./mirrorSync";
import { emitEvent } from "./events";
import { dispatchAppAuthRequired } from "./auth-events";

export interface SourceManifest {
  uploadId: string;
  sha256: string;
  size: number;
  chunks: number;
  name: string;
  type: string;
}
interface Catalog {
  books: {
    id: string;
    hasReaderData: boolean;
    source: SourceManifest | null;
  }[];
  deletedBookIds: string[];
  folders: Folder[];
}

/**
 * Upload only: local browser data is the source of truth. This intentionally
 * never reads individual server books, so a manual upload cannot overwrite
 * the browser cache with a server-side version.
 */
export async function syncBrowserToMySql() {
  const catalog = (await (await libraryRequest("/books")).json()) as Catalog;
  for (const folder of await getAllFolders()) {
    if (!catalog.folders.some(remote => remote.id === folder.id))
      await emitEvent("folder.created", {
        extId: folder.id,
        name: folder.name,
      });
  }
  for (const book of await getAllBooks()) {
    if (catalog.deletedBookIds.includes(book.id))
      throw new Error(`《${book.title}》已在 MySQL 删除，不能重新上传`);
    await syncBookMirror({
      extId: book.id,
      title: book.title,
      author: book.author,
      format: book.format,
      folder: book.folderId,
      contentHash: book.contentHash,
      metadata: book.metadata,
      chapters: book.chapters,
    });
    await saveReaderState(book);
    const remote = catalog.books.find(item => item.id === book.id);
    if (!remote?.source) {
      const file = await getFile(book.id);
      if (file) await uploadBookSource(book, file);
    }
  }
  await flushPendingReaderStates();
}

/** Merge server books into this browser while retaining browser-only books. */
export async function syncMySqlToBrowser() {
  const catalog = (await (await libraryRequest("/books")).json()) as Catalog;
  await downloadCatalog(catalog);
}

/** Mirror MySQL into this browser, removing books that are absent remotely. */
export async function syncMySqlMirrorToBrowser() {
  const catalog = (await (await libraryRequest("/books")).json()) as Catalog;
  const remoteBookIds = new Set(catalog.books.map(book => book.id));
  // A mirror pull makes the server catalog authoritative. deleteBook performs
  // the full IndexedDB cascade (file, highlights, reader state, etc.).
  for (const book of await getAllBooks()) {
    if (!remoteBookIds.has(book.id)) await deleteBook(book.id);
  }
  const remoteFolderIds = new Set(catalog.folders.map(folder => folder.id));
  for (const folder of await getAllFolders()) {
    if (!remoteFolderIds.has(folder.id)) await deleteFolder(folder.id);
  }
  await downloadCatalog(catalog);
}

async function downloadCatalog(catalog: Catalog) {
  for (const folder of catalog.folders) await putFolder(folder);
  const localFolders = await getAllFolders();
  for (const summary of catalog.books) {
    const { book, source } = (await (
      await libraryRequest(`/books/${encodeURIComponent(summary.id)}`)
    ).json()) as { book: Book; source: SourceManifest | null };
    if (
      book.folderId &&
      !localFolders.some(folder => folder.id === book.folderId)
    )
      await putFolder({
        id: book.folderId,
        name: "已恢复的文件夹",
        createdAt: Date.now(),
      });
    if (source && !(await getFile(book.id))) {
      const response = await libraryRequest(
        `/books/${encodeURIComponent(book.id)}/source`,
        { signal: AbortSignal.timeout(10 * 60_000) }
      );
      const bytes = await response.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        byte => byte.toString(16).padStart(2, "0")
      ).join("");
      if (bytes.byteLength !== source.size || hash !== source.sha256)
        throw new Error("服务端原文件校验失败，请重试同步");
      await cacheServerBook(book, {
        id: book.id,
        type: book.format,
        name: source.name,
        data: new Blob([bytes], { type: source.type }),
      });
    } else await cacheServerBook(book);
  }
}
export async function libraryRequest(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch
) {
  const response = await fetchImpl(`/api/library${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  if (response.status === 401) dispatchAppAuthRequired();
  if (!response.ok)
    throw new Error(`服务端书库请求失败（HTTP ${response.status}）`);
  return response;
}

export function bookReaderState(book: Book) {
  return {
    cover: book.cover ?? null,
    customCover: book.customCover ?? null,
    coverTone: book.coverTone,
    createdAt: book.createdAt,
    lastOpenedAt: book.lastOpenedAt,
    progress: book.progress,
    readerMode: book.readerMode,
    typeSettings: book.typeSettings,
    pageCount: book.pageCount,
    outline: book.outline,
  };
}

async function saveReaderState(book: Book) {
  await libraryRequest(`/books/${encodeURIComponent(book.id)}/state`, {
    method: "PATCH",
    body: JSON.stringify(bookReaderState(book)),
  });
}

export async function uploadBookSource(book: Book, file: StoredFile) {
  const bytes = new Uint8Array(
    file.data instanceof Blob ? await file.data.arrayBuffer() : file.data
  );
  if (bytes.length > 256 * 1024 * 1024)
    throw new Error("原文件超过 256 MiB 服务端保存上限");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")
  ).join("");
  const chunkBytes = 256 * 1024;
  const count = Math.ceil(bytes.length / chunkBytes);
  const base = `/books/${encodeURIComponent(book.id)}/source`;
  for (let index = 0; index < count; index++) {
    const part = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    let binary = "";
    for (let offset = 0; offset < part.length; offset += 8192)
      binary += String.fromCharCode(...part.subarray(offset, offset + 8192));
    await libraryRequest(`${base}/chunks`, {
      method: "PUT",
      body: JSON.stringify({ uploadId: hash, index, payload: btoa(binary) }),
    });
  }
  const manifest: SourceManifest = {
    uploadId: hash,
    sha256: hash,
    size: bytes.length,
    chunks: count,
    name: file.name ?? `${book.title}.${file.type}`,
    type:
      file.data instanceof Blob ? file.data.type : "application/octet-stream",
  };
  await libraryRequest(`${base}/complete`, {
    method: "POST",
    body: JSON.stringify(manifest),
  });
}

export async function persistImportedBook(book: Book, file?: StoredFile) {
  await saveReaderState(book);
  if (file) await uploadBookSource(book, file);
}

let flushing: Promise<void> | undefined;
function flushPendingReaderStates() {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const item of await pendingReaderStates()) {
      await libraryRequest(`/books/${encodeURIComponent(item.bookId)}/state`, {
        method: "PATCH",
        body: JSON.stringify(item.patch),
      });
      await acknowledgeReaderState(item);
    }
  })().finally(() => {
    flushing = undefined;
  });
  return flushing;
}

/** Wait for cache hydration so its snapshot cannot race an acknowledged edit. */
export function flushReaderStates(): Promise<void> {
  return synchronizing
    ? synchronizing.then(flushPendingReaderStates)
    : flushPendingReaderStates();
}

let synchronizing: Promise<void> | undefined;
/** Migrate local-only books, then rebuild this browser's cache from MySQL. */
export function synchronizeLibrary() {
  if (synchronizing) return synchronizing;
  synchronizing = (async () => {
    const catalog = (await (await libraryRequest("/books")).json()) as Catalog;
    const deleted = new Set(catalog.deletedBookIds);
    for (const folder of await getAllFolders()) {
      if (!catalog.folders.some(remote => remote.id === folder.id))
        await emitEvent("folder.created", {
          extId: folder.id,
          name: folder.name,
        });
    }
    const localBooks = await getAllBooks();
    for (const book of localBooks) {
      if (deleted.has(book.id)) {
        await deleteBook(book.id);
        continue;
      }
      const remote = catalog.books.find(item => item.id === book.id);
      if (!remote) {
        await syncBookMirror({
          extId: book.id,
          title: book.title,
          author: book.author,
          format: book.format,
          folder: book.folderId,
          contentHash: book.contentHash,
          metadata: book.metadata,
          chapters: book.chapters,
        });
      }
      if (!remote?.hasReaderData) await saveReaderState(book);
      if (!remote?.source) {
        const file = await getFile(book.id);
        if (file) await uploadBookSource(book, file);
      }
    }
    await flushPendingReaderStates();
    const refreshed = (await (
      await libraryRequest("/books")
    ).json()) as Catalog;
    for (const folder of refreshed.folders) await putFolder(folder);
    const localFolders = await getAllFolders();
    for (const summary of refreshed.books) {
      const { book, source } = (await (
        await libraryRequest(`/books/${encodeURIComponent(summary.id)}`)
      ).json()) as { book: Book; source: SourceManifest | null };
      if (
        book.folderId &&
        !localFolders.some(folder => folder.id === book.folderId)
      )
        await putFolder({
          id: book.folderId,
          name: "已恢复的文件夹",
          createdAt: Date.now(),
        });
      if (source && !(await getFile(book.id))) {
        const response = await libraryRequest(
          `/books/${encodeURIComponent(book.id)}/source`,
          { signal: AbortSignal.timeout(10 * 60_000) }
        );
        const bytes = await response.arrayBuffer();
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          byte => byte.toString(16).padStart(2, "0")
        ).join("");
        if (bytes.byteLength !== source.size || hash !== source.sha256)
          throw new Error("服务端原文件校验失败，请重试同步");
        await cacheServerBook(book, {
          id: book.id,
          type: book.format,
          name: source.name,
          data: new Blob([bytes], { type: source.type }),
        });
      } else await cacheServerBook(book);
    }
  })().finally(() => {
    synchronizing = undefined;
  });
  return synchronizing;
}
