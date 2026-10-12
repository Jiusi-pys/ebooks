import { hashObjectBytes } from "@contracts/core-field-objects";
import type { Book } from "@/types";
import {
  isEpubLayout,
  type EpubLayout,
  type EpubFigureChild,
} from "./epubLayout";

export const EPUB_LAYOUT_EVENT = "shufang:epub-layout-updated";
export const EPUB_LAYOUT_CHANNEL = "shufang:epub-layout";
export const epubLayoutKey = (bookId: string) => `epub-layout:${bookId}`;

interface LayoutEntry {
  key: string;
  version: 1;
  bookId: string;
  sourceSha256: string;
  structureSha256: string;
  layout: EpubLayout;
}

interface LayoutTransaction {
  objectStoreNames: { contains(name: string): boolean };
  objectStore(name: string): {
    get(key: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only source-aligned reading structure; catalogue edits and progress are excluded. */
export function epubBookFingerprint(book: Pick<Book, "chapters">): string {
  const data = JSON.stringify({
    version: 1,
    chapters: book.chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      paragraphs: chapter.paragraphs,
      footnotes: chapter.footnotes ?? [],
    })),
  });
  return hashObjectBytes(new TextEncoder().encode(data));
}

function matchesBook(layout: EpubLayout, book: Book): boolean {
  const chapters = new Map(book.chapters.map(chapter => [chapter.id, chapter]));
  if (
    chapters.size !== book.chapters.length ||
    Object.keys(layout.chapters).length !== chapters.size
  )
    return false;
  for (const [chapterId, value] of Object.entries(layout.chapters)) {
    const chapter = chapters.get(chapterId);
    if (!chapter) return false;
    const seen = new Set<number>();
    const validItem = (item: EpubFigureChild) => {
      if (item.kind !== "paragraph") return true;
      const paragraph = chapter.paragraphs[item.paraIndex];
      if (
        typeof paragraph !== "string" ||
        seen.has(item.paraIndex) ||
        !(item.inlineImages ?? []).every(
          image => image.offset <= paragraph.length
        )
      )
        return false;
      seen.add(item.paraIndex);
      return true;
    };
    if (
      !value.items.every(item =>
        item.kind === "figure" ? item.items.every(validItem) : validItem(item)
      )
    )
      return false;
    // A layout replaces the paragraph renderer, so partial coverage would hide source text.
    if (seen.size !== chapter.paragraphs.length) return false;
  }
  return true;
}

export function createEpubLayoutEntry(
  book: Book,
  sourceSha256: string,
  layout: EpubLayout
): LayoutEntry {
  if (
    book.format !== "epub" ||
    !/^[a-f0-9]{64}$/.test(sourceSha256) ||
    !isEpubLayout(layout) ||
    !matchesBook(layout, book)
  )
    throw new Error("invalid_epub_layout");
  return {
    key: epubLayoutKey(book.id),
    version: 1,
    bookId: book.id,
    sourceSha256,
    structureSha256: epubBookFingerprint(book),
    layout,
  };
}

/** Read one coherent snapshot. Missing/unknown/stale caches safely use text. */
export async function getEpubLayout(
  book: Book
): Promise<EpubLayout | undefined> {
  if (book.format !== "epub") return;
  const { syncDatabase } = await import("./db");
  const tx = (await syncDatabase()).transaction(
    ["books", "sources", "metadata", "syncEntities"],
    "readonly"
  );
  const [stored, source, entry, state] = await Promise.all([
    tx.objectStore("books").get(book.id),
    tx.objectStore("sources").get(book.id),
    tx.objectStore("metadata").get(epubLayoutKey(book.id)),
    tx.objectStore("syncEntities").get(`books:${book.id}`),
  ]);
  await tx.done;
  try {
    if (
      !stored ||
      stored.format !== "epub" ||
      !Array.isArray(stored.chapters) ||
      state?.state?.deleted ||
      !source ||
      source.format !== "epub" ||
      !/^[a-f0-9]{64}$/.test(source.sha256 ?? "") ||
      !record(entry) ||
      entry.version !== 1 ||
      entry.bookId !== book.id ||
      entry.key !== epubLayoutKey(book.id) ||
      entry.sourceSha256 !== source.sha256 ||
      !isEpubLayout(entry.layout) ||
      !matchesBook(entry.layout, stored)
    )
      return;
    const structure = epubBookFingerprint(stored);
    if (
      entry.structureSha256 !== structure ||
      epubBookFingerprint(book) !== structure
    )
      return;
    return entry.layout;
  } catch {
    // Corrupt legacy projections are not repaired by changing user text.
    return;
  }
}

/** Called inside the business/replication transaction; never emits operations. */
export async function invalidateEpubLayout(
  tx: LayoutTransaction,
  kind: string,
  bookId: string,
  next: unknown
): Promise<boolean> {
  if (
    (kind !== "books" && kind !== "sources") ||
    !tx.objectStoreNames.contains("metadata")
  )
    return false;
  const store = tx.objectStore("metadata");
  const entry = await store.get(epubLayoutKey(bookId));
  if (!record(entry)) return false;
  let keep = false;
  if (record(next)) {
    if (kind === "sources")
      keep = next.sha256 === entry.sourceSha256 && next.format === "epub";
    else if (next.format === "epub" && Array.isArray(next.chapters)) {
      try {
        keep =
          epubBookFingerprint(next as unknown as Book) ===
          entry.structureSha256;
      } catch {
        /* An invalid projection cannot retain a source-aligned cache. */
      }
    }
  }
  if (keep) return false;
  await store.delete(epubLayoutKey(bookId));
  return true;
}

/** Publish only committed cache changes; channel messages never carry book content. */
export function notifyEpubLayoutChanged(bookId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(EPUB_LAYOUT_EVENT, { detail: { bookId } })
  );
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(EPUB_LAYOUT_CHANNEL);
      try {
        channel.postMessage({ bookId });
      } finally {
        channel.close();
      }
    } catch {
      // Storage is already committed; unavailable cross-tab hints are not a failed write.
    }
  }
}
