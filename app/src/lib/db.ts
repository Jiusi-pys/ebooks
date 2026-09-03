import { openDB, type IDBPDatabase } from "idb";
import type {
  Association,
  Book,
  ChapterTranslation,
  Folder,
  FolderIconKey,
  Highlight,
  MindMap,
  Note,
  OutlineItem,
  StudySet,
} from "@/types";

export const SHUFANG_DB_NAME = "shufang";
export const SHUFANG_DB_VERSION = 7;

const SEED_MARKER_KEY = "example-library-v1";

let dbp: Promise<IDBPDatabase> | null = null;
let openedDatabase: IDBPDatabase | null = null;

export type DatabaseConnectionIssueKind =
  "upgrade-blocked" | "connection-closed" | "open-failed";

export interface DatabaseConnectionIssue {
  kind: DatabaseConnectionIssueKind;
  message: string;
}

let databaseIssue: DatabaseConnectionIssue | null = null;
const databaseIssueListeners = new Set<
  (issue: DatabaseConnectionIssue | null) => void
>();

function publishDatabaseIssue(issue: DatabaseConnectionIssue | null) {
  databaseIssue = issue;
  for (const listener of databaseIssueListeners) listener(issue);
}

/**
 * Observe IndexedDB lifecycle failures that would otherwise leave the app on
 * an unexplained loading screen. The current value is delivered immediately.
 */
export function subscribeDatabaseConnectionIssue(
  listener: (issue: DatabaseConnectionIssue | null) => void
) {
  databaseIssueListeners.add(listener);
  listener(databaseIssue);
  return () => {
    databaseIssueListeners.delete(listener);
  };
}

export function getDatabaseConnectionIssue() {
  return databaseIssue;
}

/** Close this tab's handle so another tab can complete a schema upgrade. */
export function closeDatabaseConnection() {
  openedDatabase?.close();
  openedDatabase = null;
  dbp = null;
}

function db() {
  if (!dbp) {
    const pending = openDB(SHUFANG_DB_NAME, SHUFANG_DB_VERSION, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore("books", { keyPath: "id" });
          d.createObjectStore("notes", { keyPath: "id" });
          const hl = d.createObjectStore("highlights", { keyPath: "id" });
          hl.createIndex("by-book", "bookId");
        }
        if (oldVersion < 2) {
          d.createObjectStore("folders", { keyPath: "id" });
        }
        if (oldVersion < 3) {
          d.createObjectStore("translations", { keyPath: "id" });
          d.createObjectStore("mindMaps", { keyPath: "id" });
        }
        if (oldVersion < 4) {
          // 原始 PDF 文件（ArrayBuffer 或 Blob），原版阅读模式按需加载渲染
          d.createObjectStore("files", { keyPath: "id" });
        }
        if (oldVersion < 5) {
          d.createObjectStore("studySets", { keyPath: "id" });
        }
        if (oldVersion < 6) {
          const associations = d.createObjectStore("associations", {
            keyPath: "id",
          });
          associations.createIndex("by-source-book", "source.bookId");
          associations.createIndex("by-target-book", "target.bookId");
          associations.createIndex("by-pair", "pairKey", { unique: true });
        }
        if (oldVersion < 7) {
          const metadata = d.createObjectStore("metadata", {
            keyPath: "key",
          });
          if (oldVersion > 0) {
            // Any pre-existing database may once have contained user data.
            // Mark it initialized during upgrade so deleting every book never
            // causes demo records to reappear on the next launch.
            metadata.put({
              key: SEED_MARKER_KEY,
              initializedAt: Date.now(),
              reason: "existing-database",
            });
          }
        }
      },
      blocked() {
        publishDatabaseIssue({
          kind: "upgrade-blocked",
          message:
            "数据库升级被其他书房标签页阻止。请关闭其他标签页，然后返回此页重试。",
        });
      },
      blocking() {
        // Cooperate with a newer tab instead of holding its upgrade request
        // forever. A reload is still required before this tab can read again.
        openedDatabase?.close();
        openedDatabase = null;
        if (dbp === pending) dbp = null;
        publishDatabaseIssue({
          kind: "connection-closed",
          message: "书房数据结构已在另一标签页升级，请重新加载此页面。",
        });
      },
      terminated() {
        openedDatabase = null;
        if (dbp === pending) dbp = null;
        publishDatabaseIssue({
          kind: "connection-closed",
          message: "浏览器意外关闭了本地数据库连接，请重新加载此页面。",
        });
      },
    })
      .then(database => {
        openedDatabase = database;
        publishDatabaseIssue(null);
        return database;
      })
      .catch(reason => {
        if (dbp === pending) dbp = null;
        publishDatabaseIssue({
          kind: "open-failed",
          message:
            reason instanceof Error
              ? `无法打开本地书库：${reason.message}`
              : "无法打开本地书库，请重新加载后再试。",
        });
        throw reason;
      });
    dbp = pending;
  }
  return dbp;
}

export const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function getAllBooks(): Promise<Book[]> {
  const all = (await (await db()).getAll("books")) as Book[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putBook(book: Book) {
  await (await db()).put("books", book);
}

export interface LibrarySeedPayload {
  book: Book;
  notes: Note[];
  highlights: Highlight[];
}

/**
 * Seed a truly new library exactly once.
 *
 * The marker check, empty-library check and inserts share one transaction, so
 * two tabs starting together cannot both seed. Existing content in any user
 * store permanently suppresses the examples; seed IDs are added, never put,
 * so this path cannot replace a user's record.
 */
export async function seedLibraryIfUnused(
  seed: LibrarySeedPayload
): Promise<boolean> {
  const database = await db();
  const userStores = [
    "books",
    "notes",
    "highlights",
    "folders",
    "translations",
    "mindMaps",
    "files",
    "studySets",
    "associations",
  ] as const;
  const tx = database.transaction([...userStores, "metadata"], "readwrite");
  const metadata = tx.objectStore("metadata");
  if (await metadata.get(SEED_MARKER_KEY)) {
    await tx.done;
    return false;
  }

  let hasUserData = false;
  for (const storeName of userStores) {
    if ((await tx.objectStore(storeName).count()) > 0) {
      hasUserData = true;
      break;
    }
  }

  if (!hasUserData) {
    await tx.objectStore("books").add(seed.book);
    for (const note of seed.notes) await tx.objectStore("notes").add(note);
    for (const highlight of seed.highlights)
      await tx.objectStore("highlights").add(highlight);
  }
  await metadata.put({
    key: SEED_MARKER_KEY,
    initializedAt: Date.now(),
    reason: hasUserData ? "existing-data" : "seeded",
  });
  await tx.done;
  return !hasUserData;
}

async function patchStoredBook(
  bookId: string,
  update: (current: Book) => Book
): Promise<Book | undefined> {
  const database = await db();
  const tx = database.transaction("books", "readwrite");
  const current = (await tx.store.get(bookId)) as Book | undefined;
  if (!current) {
    await tx.done;
    return undefined;
  }
  const updated = update(current);
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

/**
 * Persist only reading progress against the newest stored Book value.
 *
 * A scroll callback is deliberately not allowed to write its captured Book
 * snapshot: outline, cover, folder and reader-setting edits may have landed
 * while the debounced callback was waiting.
 */
export async function patchBookProgress(
  bookId: string,
  chapterId: string,
  ratio: number
): Promise<Book | undefined> {
  return patchStoredBook(bookId, current => ({
    ...current,
    progress: {
      chapterId,
      ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
    },
  }));
}

export async function patchBookCustomCover(
  bookId: string,
  dataUrl?: string
): Promise<Book | undefined> {
  return patchStoredBook(bookId, current => {
    const updated: Book = { ...current };
    if (dataUrl) updated.customCover = dataUrl;
    else delete updated.customCover;
    return updated;
  });
}

export async function patchBookReaderMode(
  bookId: string,
  readerMode: "reflow" | "original"
): Promise<Book | undefined> {
  return patchStoredBook(bookId, current => ({ ...current, readerMode }));
}

export async function patchBookTitle(
  bookId: string,
  title: string
): Promise<Book | undefined> {
  return patchStoredBook(bookId, current => ({ ...current, title }));
}

export async function patchBookOutline(
  bookId: string,
  outline: OutlineItem[]
): Promise<Book | undefined> {
  return patchStoredBook(bookId, current => ({ ...current, outline }));
}

export async function patchBookFolder(
  bookId: string,
  folderId: string | undefined
): Promise<Book | undefined> {
  const database = await db();
  // Share the same store scope as deleteFolder. IndexedDB then serializes the
  // two operations across tabs, and a move can never recreate a deleted ID.
  const tx = database.transaction(["books", "folders"], "readwrite");
  if (folderId && !(await tx.objectStore("folders").get(folderId))) {
    await tx.done;
    return undefined;
  }
  const bookStore = tx.objectStore("books");
  const current = (await bookStore.get(bookId)) as Book | undefined;
  if (!current) {
    await tx.done;
    return undefined;
  }
  const updated: Book = { ...current };
  if (folderId) updated.folderId = folderId;
  else delete updated.folderId;
  await bookStore.put(updated);
  await tx.done;
  return updated;
}

export async function deleteBook(id: string) {
  const d = await db();
  const tx = d.transaction(
    ["books", "files", "highlights", "studySets", "associations"],
    "readwrite"
  );
  await tx.objectStore("books").delete(id);
  await tx.objectStore("files").delete(id);

  const highlightStore = tx.objectStore("highlights");
  const highlightKeys = (await highlightStore
    .index("by-book")
    .getAllKeys(id)) as string[];
  for (const key of highlightKeys) await highlightStore.delete(key);

  const associationStore = tx.objectStore("associations");
  const [sourceKeys, targetKeys] = await Promise.all([
    associationStore.index("by-source-book").getAllKeys(id),
    associationStore.index("by-target-book").getAllKeys(id),
  ]);
  for (const key of new Set([...sourceKeys, ...targetKeys]))
    await associationStore.delete(key);

  const sets = (await tx.objectStore("studySets").getAll()) as StudySet[];
  for (const set of sets) {
    if (set.bookIds.includes(id)) {
      await tx.objectStore("studySets").put({
        ...set,
        bookIds: set.bookIds.filter(bookId => bookId !== id),
        updatedAt: Date.now(),
      });
    }
  }
  await tx.done;
}

/* ---------- 原始文件（PDF 原版模式用） ---------- */

export interface StoredFile {
  id: string; // 与 book.id 相同
  type: "pdf";
  /** 新导入使用 Blob 避免导入阶段再次读取整文件；兼容旧 ArrayBuffer。 */
  data: ArrayBuffer | Blob;
}

/** Commit an imported book and its optional source PDF as one atomic unit. */
export async function putImportedBook(book: Book, file?: StoredFile) {
  const database = await db();
  const tx = database.transaction(["books", "files"], "readwrite");
  await tx.objectStore("books").put(book);
  if (file) await tx.objectStore("files").put(file);
  await tx.done;
}

export async function putFile(f: StoredFile) {
  await (await db()).put("files", f);
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  return (await (await db()).get("files", id)) as StoredFile | undefined;
}

export async function deleteFile(id: string) {
  await (await db()).delete("files", id).catch(() => undefined);
}

export async function getAllFolders(): Promise<Folder[]> {
  const all = (await (await db()).getAll("folders")) as Folder[];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function putFolder(f: Folder) {
  await (await db()).put("folders", f);
}

async function patchStoredFolder(
  folderId: string,
  update: (current: Folder) => Folder
): Promise<Folder | undefined> {
  const database = await db();
  const tx = database.transaction("folders", "readwrite");
  const current = (await tx.store.get(folderId)) as Folder | undefined;
  if (!current) {
    await tx.done;
    return undefined;
  }
  const updated = update(current);
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

export async function patchFolderIcon(
  folderId: string,
  icon: FolderIconKey
): Promise<Folder | undefined> {
  return patchStoredFolder(folderId, current => ({ ...current, icon }));
}

export async function patchFolderName(
  folderId: string,
  name: string
): Promise<Folder | undefined> {
  return patchStoredFolder(folderId, current => ({ ...current, name }));
}

/** 删除文件夹：其中书籍移回未分类 */
export async function deleteFolder(id: string) {
  const d = await db();
  const tx = d.transaction(["folders", "books"], "readwrite");
  await tx.objectStore("folders").delete(id);
  const bookStore = tx.objectStore("books");
  const books = (await bookStore.getAll()) as Book[];
  for (const b of books) {
    if (b.folderId === id) {
      const updated = { ...b };
      delete updated.folderId;
      await bookStore.put(updated);
    }
  }
  await tx.done;
}

/* ---------- 独立学习集（与文件夹无关） ---------- */

export async function getAllStudySets(): Promise<StudySet[]> {
  const all = (await (await db()).getAll("studySets")) as StudySet[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putStudySet(set: StudySet) {
  await (await db()).put("studySets", set);
}

export async function deleteStudySet(id: string) {
  await (await db()).delete("studySets", id);
}

export async function getAllNotes(): Promise<Note[]> {
  const all = (await (await db()).getAll("notes")) as Note[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putNote(note: Note) {
  await (await db()).put("notes", note);
}

export async function deleteNote(id: string) {
  const d = await db();
  await d.delete("notes", id);
  // 清除书摘上对该笔记的关联
  const all = (await d.getAll("highlights")) as Highlight[];
  const tx = d.transaction("highlights", "readwrite");
  for (const h of all) {
    if (h.noteId === id) {
      h.noteId = undefined;
      h.citation = undefined;
      await tx.store.put(h);
    }
  }
  await tx.done;
}

export async function getHighlights(bookId?: string): Promise<Highlight[]> {
  const d = await db();
  const all = bookId
    ? ((await d.getAllFromIndex(
        "highlights",
        "by-book",
        bookId
      )) as Highlight[])
    : ((await d.getAll("highlights")) as Highlight[]);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putHighlight(h: Highlight) {
  await (await db()).put("highlights", h);
}

export async function deleteHighlight(id: string) {
  await (await db()).delete("highlights", id);
}

/* ---------- 文段关联（独立于书摘与引用） ---------- */

export async function getAllAssociations(
  bookId?: string
): Promise<Association[]> {
  const d = await db();
  let all: Association[];
  if (bookId) {
    const [source, target] = await Promise.all([
      d.getAllFromIndex("associations", "by-source-book", bookId),
      d.getAllFromIndex("associations", "by-target-book", bookId),
    ]);
    all = [
      ...new Map(
        ([...source, ...target] as Association[]).map(item => [item.id, item])
      ).values(),
    ];
  } else {
    all = (await d.getAll("associations")) as Association[];
  }
  return all.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function putAssociation(association: Association) {
  await (await db()).put("associations", association);
}

export interface AddAssociationIfAbsentResult {
  association: Association;
  created: boolean;
}

/**
 * Return the association already owning this pair, or create the candidate.
 *
 * IndexedDB serializes readwrite transactions which overlap the same object
 * store. Keeping the unique-index lookup and add in this transaction therefore
 * makes concurrent callers converge on the record that was actually persisted.
 */
export async function addAssociationIfAbsent(
  candidate: Association
): Promise<AddAssociationIfAbsentResult> {
  const database = await db();
  const tx = database.transaction("associations", "readwrite");
  const store = tx.objectStore("associations");
  const existing = (await store.index("by-pair").get(candidate.pairKey)) as
    Association | undefined;

  if (existing) {
    await tx.done;
    return { association: existing, created: false };
  }

  await store.add(candidate);
  await tx.done;
  return { association: candidate, created: true };
}

export async function deleteAssociation(id: string) {
  await (await db()).delete("associations", id);
}

/* ---------- 章节译文缓存 ---------- */

export function translationId(
  bookId: string,
  chapterId: string,
  targetLang: string
) {
  return `${bookId}:${chapterId}:${targetLang}`;
}

export async function getChapterTranslation(
  bookId: string,
  chapterId: string,
  targetLang: string
): Promise<ChapterTranslation | undefined> {
  return (await (
    await db()
  ).get("translations", translationId(bookId, chapterId, targetLang))) as
    ChapterTranslation | undefined;
}

export async function putChapterTranslation(t: ChapterTranslation) {
  await (await db()).put("translations", t);
}

/* ---------- 脑图 ---------- */

export async function getAllMindMaps(): Promise<MindMap[]> {
  const all = (await (await db()).getAll("mindMaps")) as MindMap[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putMindMap(map: MindMap) {
  await (await db()).put("mindMaps", map);
}

export async function deleteMindMap(id: string) {
  await (await db()).delete("mindMaps", id);
}
