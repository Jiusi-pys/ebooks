import { useCallback, useEffect, useState } from "react";
import type {
  Book,
  Folder,
  Highlight,
  MindMap,
  Note,
  OutlineItem,
  Route,
  StudySet,
} from "@/types";
import {
  deleteBook as dbDeleteBook,
  deleteFolder as dbDeleteFolder,
  deleteHighlight as dbDeleteHighlight,
  deleteMindMap as dbDeleteMindMap,
  deleteNote as dbDeleteNote,
  deleteStudySet as dbDeleteStudySet,
  getAllBooks,
  getAllFolders,
  getAllMindMaps,
  getAllNotes,
  getAllStudySets,
  getFile,
  getHighlights,
  putBook,
  putFile,
  putFolder,
  putHighlight,
  putMindMap,
  putNote,
  putStudySet,
  uid,
} from "@/lib/db";
import { parsePdf, type ParsedBook } from "@/lib/parsePdf";
import { parseEpub } from "@/lib/parseEpub";
import { toneForTitle } from "@/lib/covers";
import { seedIfEmpty } from "@/lib/seed";
import { emitEvent } from "@/lib/events";

export interface ImportTask {
  id: string;
  name: string;
  stage: string;
  ratio: number;
  status: "working" | "done" | "error";
  error?: string;
}

export function useLibrary() {
  const [ready, setReady] = useState(false);
  const [books, setBooks] = useState<Book[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [mindMaps, setMindMaps] = useState<MindMap[]>([]);
  const [studySets, setStudySets] = useState<StudySet[]>([]);
  const [route, setRoute] = useState<Route>({ view: "library" });
  const [imports, setImports] = useState<ImportTask[]>([]);

  const reload = useCallback(async () => {
    const [b, n, h, f, m, s] = await Promise.all([
      getAllBooks(),
      getAllNotes(),
      getHighlights(),
      getAllFolders(),
      getAllMindMaps(),
      getAllStudySets(),
    ]);
    setBooks(b);
    setNotes(n);
    setHighlights(h);
    setFolders(f);
    setMindMaps(m);
    setStudySets(s);
  }, []);

  useEffect(() => {
    (async () => {
      await seedIfEmpty();
      await reload();
      setReady(true);
    })();
  }, [reload]);

  const navigate = useCallback((r: Route) => setRoute(r), []);

  const importFiles = useCallback(
    async (files: File[], pdfModes?: Map<File, "reflow" | "original">) => {
      for (const file of files) {
        const taskId = uid();
        const ext = file.name.toLowerCase();
        const isPdf = ext.endsWith(".pdf");
        if (!isPdf && !ext.endsWith(".epub")) {
          setImports(s => [
            ...s,
            {
              id: taskId,
              name: file.name,
              stage: "不支持的格式",
              ratio: 1,
              status: "error",
              error: "仅支持 PDF / EPUB",
            },
          ]);
          continue;
        }
        setImports(s => [
          ...s,
          {
            id: taskId,
            name: file.name,
            stage: "排队中",
            ratio: 0,
            status: "working",
          },
        ]);
        try {
          const onProgress = (stage: string, ratio: number) =>
            setImports(s =>
              s.map(t => (t.id === taskId ? { ...t, stage, ratio } : t))
            );
          const parsed: ParsedBook = isPdf
            ? await parsePdf(file, onProgress)
            : await parseEpub(file, onProgress);
          const readerMode = isPdf
            ? (pdfModes?.get(file) ?? "reflow")
            : undefined;
          const book: Book = {
            id: uid(),
            title: parsed.title,
            author: parsed.author,
            format: isPdf ? "pdf" : "epub",
            cover: parsed.cover,
            coverTone: toneForTitle(parsed.title),
            chapters: parsed.chapters,
            createdAt: Date.now(),
            progress: { chapterId: parsed.chapters[0]?.id ?? "", ratio: 0 },
            readerMode,
            pageCount: isPdf ? parsed.pageCount : undefined,
          };
          if (isPdf) {
            onProgress("保存原始文件", 0.97);
            // 同时保存原始 PDF 字节，之后可随时切换 重排 / 原版
            await putFile({
              id: book.id,
              type: "pdf",
              data: await file.arrayBuffer(),
            });
          }
          await putBook(book);
          emitEvent("book.imported", {
            extId: book.id,
            title: book.title,
            author: book.author,
            format: book.format,
            chapters: book.chapters.map(c => ({
              id: c.id,
              title: c.title,
              paragraphs: c.paragraphs,
            })),
          });
          setImports(s =>
            s.map(t =>
              t.id === taskId
                ? { ...t, stage: "完成", ratio: 1, status: "done" }
                : t
            )
          );
        } catch (e) {
          setImports(s =>
            s.map(t =>
              t.id === taskId
                ? {
                    ...t,
                    stage: "失败",
                    ratio: 1,
                    status: "error",
                    error: e instanceof Error ? e.message : "解析失败",
                  }
                : t
            )
          );
        }
      }
      await reload();
    },
    [reload]
  );

  /** 切换 PDF 书籍的 重排 / 原版 阅读模式；切到原版但无原始文件时返回 false */
  const setReaderMode = useCallback(
    async (bookId: string, mode: "reflow" | "original"): Promise<boolean> => {
      const book = books.find(b => b.id === bookId);
      if (!book || book.format !== "pdf") return false;
      if (mode === "original") {
        const f = await getFile(bookId);
        if (!f) return false;
      }
      const updated: Book = { ...book, readerMode: mode };
      await putBook(updated);
      setBooks(s => s.map(b => (b.id === bookId ? updated : b)));
      return true;
    },
    [books]
  );

  const dismissImport = useCallback((id: string) => {
    setImports(s => s.filter(t => t.id !== id));
  }, []);

  const openReader = useCallback((bookId: string, chapterId?: string) => {
    setRoute({ view: "reader", bookId, chapterId });
  }, []);

  const saveProgress = useCallback(
    async (bookId: string, chapterId: string, ratio: number) => {
      const book = books.find(b => b.id === bookId);
      if (!book) return;
      const updated = { ...book, progress: { chapterId, ratio } };
      await putBook(updated);
      setBooks(s => s.map(b => (b.id === bookId ? updated : b)));
    },
    [books]
  );

  const createNote = useCallback(
    async (title: string): Promise<Note> => {
      const note: Note = {
        id: uid(),
        title: title.trim() || "未命名笔记",
        content: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await putNote(note);
      await reload();
      return note;
    },
    [reload]
  );

  /** 双链跳转：按标题找笔记/书，找不到则新建同名笔记 */
  const openByTitle = useCallback(
    async (title: string) => {
      const lower = title.trim().toLowerCase();
      const book = books.find(b => b.title.toLowerCase() === lower);
      if (book) {
        setRoute({ view: "reader", bookId: book.id });
        return;
      }
      let note = notes.find(n => n.title.toLowerCase() === lower);
      if (!note) note = await createNote(title.trim());
      setRoute({ view: "note", noteId: note.id });
    },
    [books, notes, createNote]
  );

  const saveNote = useCallback(async (note: Note) => {
    const updated = { ...note, updatedAt: Date.now() };
    await putNote(updated);
    setNotes(s =>
      s
        .map(n => (n.id === note.id ? updated : n))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    );
  }, []);

  const removeNote = useCallback(
    async (id: string) => {
      await dbDeleteNote(id);
      await reload();
      setRoute({ view: "notes" });
    },
    [reload]
  );

  const removeBook = useCallback(
    async (id: string) => {
      await dbDeleteBook(id);
      await reload();
      setRoute({ view: "library" });
    },
    [reload]
  );

  const renameBook = useCallback(async (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    setBooks(s => {
      const book = s.find(b => b.id === id);
      if (!book) return s;
      const updated = { ...book, title: t };
      void putBook(updated);
      return s.map(b => (b.id === id ? updated : b));
    });
  }, []);

  const updateBookOutline = useCallback(
    async (id: string, outline: OutlineItem[]) => {
      setBooks(current => {
        const book = current.find(item => item.id === id);
        if (!book) return current;
        const updated = { ...book, outline };
        void putBook(updated);
        return current.map(item => (item.id === id ? updated : item));
      });
    },
    []
  );

  const moveBook = useCallback(
    async (id: string, folderId: string | undefined) => {
      setBooks(s => {
        const book = s.find(b => b.id === id);
        if (!book) return s;
        const updated = { ...book, folderId };
        void putBook(updated);
        return s.map(b => (b.id === id ? updated : b));
      });
    },
    []
  );

  const createFolder = useCallback(async (name: string): Promise<Folder> => {
    const folder: Folder = {
      id: uid(),
      name: name.trim() || "未命名文件夹",
      createdAt: Date.now(),
    };
    await putFolder(folder);
    setFolders(s => [...s, folder]);
    return folder;
  }, []);

  const renameFolder = useCallback(async (id: string, name: string) => {
    const t = name.trim();
    if (!t) return;
    setFolders(s => {
      const f = s.find(x => x.id === id);
      if (!f) return s;
      const updated = { ...f, name: t };
      void putFolder(updated);
      return s.map(x => (x.id === id ? updated : x));
    });
  }, []);

  const removeFolder = useCallback(
    async (id: string) => {
      await dbDeleteFolder(id);
      await reload();
    },
    [reload]
  );

  const createStudySet = useCallback(
    async (name: string): Promise<StudySet> => {
      const now = Date.now();
      const set: StudySet = {
        id: uid(),
        name: name.trim() || "未命名学习集",
        description: "",
        bookIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await putStudySet(set);
      setStudySets(current => [set, ...current]);
      emitEvent("studyset.created", {
        extId: set.id,
        name: set.name,
        bookIds: [],
      });
      return set;
    },
    []
  );

  const saveStudySet = useCallback(async (set: StudySet) => {
    const updated = {
      ...set,
      name: set.name.trim() || "未命名学习集",
      bookIds: [...new Set(set.bookIds)],
      updatedAt: Date.now(),
    };
    await putStudySet(updated);
    setStudySets(current =>
      current
        .map(item => (item.id === updated.id ? updated : item))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    );
    emitEvent("studyset.updated", {
      extId: updated.id,
      name: updated.name,
      bookIds: updated.bookIds,
    });
    return updated;
  }, []);

  const removeStudySet = useCallback(async (id: string) => {
    await dbDeleteStudySet(id);
    setStudySets(current => current.filter(set => set.id !== id));
    emitEvent("studyset.deleted", { extId: id });
    setRoute(current =>
      current.view === "studyset" && current.studySetId === id
        ? { view: "studyset" }
        : current
    );
  }, []);

  const addHighlight = useCallback(
    async (h: Omit<Highlight, "id" | "createdAt">): Promise<Highlight> => {
      const full: Highlight = { ...h, id: uid(), createdAt: Date.now() };
      await putHighlight(full);
      setHighlights(s => [full, ...s]);
      return full;
    },
    []
  );

  const updateHighlight = useCallback(async (h: Highlight) => {
    await putHighlight(h);
    setHighlights(s => s.map(x => (x.id === h.id ? h : x)));
  }, []);

  const removeHighlight = useCallback(async (id: string) => {
    await dbDeleteHighlight(id);
    setHighlights(s => s.filter(h => h.id !== id));
  }, []);

  const saveMindMap = useCallback(async (map: MindMap) => {
    const updated = { ...map, updatedAt: Date.now() };
    await putMindMap(updated);
    setMindMaps(s => {
      const exists = s.some(m => m.id === map.id);
      const next = exists
        ? s.map(m => (m.id === map.id ? updated : m))
        : [updated, ...s];
      return next.sort((a, b) => b.updatedAt - a.updatedAt);
    });
    return updated;
  }, []);

  const removeMindMap = useCallback(async (id: string) => {
    await dbDeleteMindMap(id);
    setMindMaps(s => s.filter(m => m.id !== id));
  }, []);

  return {
    ready,
    books,
    notes,
    highlights,
    folders,
    mindMaps,
    studySets,
    route,
    imports,
    navigate,
    importFiles,
    setReaderMode,
    dismissImport,
    openReader,
    saveProgress,
    createNote,
    openByTitle,
    saveNote,
    removeNote,
    removeBook,
    renameBook,
    updateBookOutline,
    moveBook,
    createFolder,
    renameFolder,
    removeFolder,
    createStudySet,
    saveStudySet,
    removeStudySet,
    addHighlight,
    updateHighlight,
    removeHighlight,
    saveMindMap,
    removeMindMap,
  };
}

export type Library = ReturnType<typeof useLibrary>;
