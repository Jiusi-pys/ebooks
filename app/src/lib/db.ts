import { openDB, type IDBPDatabase } from "idb";
import type {
  Association,
  Book,
  ChapterTranslation,
  Folder,
  Highlight,
  MindMap,
  Note,
  StudySet,
} from "@/types";

const DB_NAME = "shufang";
const DB_VERSION = 6;

let dbp: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
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
      },
    });
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

/** 删除文件夹：其中书籍移回未分类 */
export async function deleteFolder(id: string) {
  const d = await db();
  await d.delete("folders", id);
  const books = (await d.getAll("books")) as Book[];
  const tx = d.transaction("books", "readwrite");
  for (const b of books) {
    if (b.folderId === id) {
      b.folderId = undefined;
      await tx.store.put(b);
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
