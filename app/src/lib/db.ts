import { openDB, type IDBPDatabase } from "idb";
import type {
  Book,
  ChapterTranslation,
  Folder,
  Highlight,
  MindMap,
  Note,
  StudySet,
} from "@/types";

const DB_NAME = "shufang";
const DB_VERSION = 5;

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
          // 原始 PDF 文件（ArrayBuffer），原版阅读模式按需加载渲染
          d.createObjectStore("files", { keyPath: "id" });
        }
        if (oldVersion < 5) {
          d.createObjectStore("studySets", { keyPath: "id" });
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
  await d.delete("books", id);
  await d.delete("files", id).catch(() => undefined);
  const keys = (await d.getAllKeysFromIndex(
    "highlights",
    "by-book",
    id
  )) as string[];
  const tx = d.transaction("highlights", "readwrite");
  for (const k of keys) await tx.store.delete(k);
  await tx.done;
  const sets = (await d.getAll("studySets")) as StudySet[];
  const setTx = d.transaction("studySets", "readwrite");
  for (const set of sets) {
    if (set.bookIds.includes(id)) {
      await setTx.store.put({
        ...set,
        bookIds: set.bookIds.filter(bookId => bookId !== id),
        updatedAt: Date.now(),
      });
    }
  }
  await setTx.done;
}

/* ---------- 原始文件（PDF 原版模式用） ---------- */

export interface StoredFile {
  id: string; // 与 book.id 相同
  type: "pdf";
  data: ArrayBuffer;
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
