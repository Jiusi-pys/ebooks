import { useCallback, useEffect, useState } from "react";
import type {
  Association,
  AssociationDirection,
  Book,
  Folder,
  Highlight,
  MindMap,
  Note,
  OutlineItem,
  PassageAnchor,
  Route,
  StudySet,
} from "@/types";
import {
  addAssociationIfAbsent,
  deleteAssociation as dbDeleteAssociation,
  deleteBook as dbDeleteBook,
  deleteFolder as dbDeleteFolder,
  deleteHighlight as dbDeleteHighlight,
  deleteMindMap as dbDeleteMindMap,
  deleteNote as dbDeleteNote,
  deleteStudySet as dbDeleteStudySet,
  getAllAssociations,
  getAllBooks,
  getAllFolders,
  getAllMindMaps,
  getAllNotes,
  getAllStudySets,
  getFile,
  getHighlights,
  putBook,
  putAssociation,
  putFolder,
  putHighlight,
  putImportedBook,
  putMindMap,
  putNote,
  putStudySet,
  type StoredFile,
  uid,
} from "@/lib/db";
import { detectBookFormat, SUPPORTED_FORMAT_LABEL } from "@/lib/bookFormats";
import { parseBookFile } from "@/lib/parseBook";
import { toneForTitle } from "@/lib/covers";
import { seedIfEmpty } from "@/lib/seed";
import { emitEvent } from "@/lib/events";
import { selectImportedPdfMode } from "@/lib/pdfReaderState";
import {
  citationDescriptorForHighlight,
  isCitationOnlyHighlight,
  removeCitationBlock,
  removeCitationBlocks,
  renameCitationBookTitles,
} from "@/lib/citations";
import {
  assertAssociationEndpoints,
  associationsForBook,
} from "@/lib/associations";

export interface ImportTask {
  id: string;
  name: string;
  stage: string;
  ratio: number;
  status: "working" | "done" | "error";
  error?: string;
}

export interface AssociationOptions {
  direction?: AssociationDirection;
  label?: string;
}

function associationEventSnapshot(association: Association) {
  return {
    extId: association.id,
    source: association.source,
    target: association.target,
    direction: association.direction,
    label: association.label,
    pairKey: association.pairKey,
    createdAt: association.createdAt,
    updatedAt: association.updatedAt,
  };
}

function citationNoteUpdates(
  notes: Note[],
  highlights: Highlight[],
  bookTitle: string,
  rewrite: (
    content: string,
    descriptors: ReturnType<typeof citationDescriptorForHighlight>[]
  ) => string
): Note[] {
  const byNote = new Map<string, Highlight[]>();
  for (const highlight of highlights) {
    if (!highlight.noteId) continue;
    const linked = byNote.get(highlight.noteId) ?? [];
    linked.push(highlight);
    byNote.set(highlight.noteId, linked);
  }

  const now = Date.now();
  return notes.flatMap(note => {
    const linked = byNote.get(note.id);
    if (!linked?.length) return [];
    const descriptors = linked.map(highlight =>
      citationDescriptorForHighlight(highlight, bookTitle)
    );
    const content = rewrite(note.content, descriptors);
    return content === note.content
      ? []
      : [{ ...note, content, updatedAt: now }];
  });
}

export function useLibrary() {
  const [ready, setReady] = useState(false);
  const [books, setBooks] = useState<Book[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [associations, setAssociations] = useState<Association[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [mindMaps, setMindMaps] = useState<MindMap[]>([]);
  const [studySets, setStudySets] = useState<StudySet[]>([]);
  const [route, setRoute] = useState<Route>({ view: "library" });
  const [imports, setImports] = useState<ImportTask[]>([]);

  const reload = useCallback(async () => {
    const [b, n, h, a, f, m, s] = await Promise.all([
      getAllBooks(),
      getAllNotes(),
      getHighlights(),
      getAllAssociations(),
      getAllFolders(),
      getAllMindMaps(),
      getAllStudySets(),
    ]);
    setBooks(b);
    setNotes(n);
    setHighlights(h);
    setAssociations(a);
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
        const format = detectBookFormat(file.name);
        if (!format) {
          setImports(s => [
            ...s,
            {
              id: taskId,
              name: file.name,
              stage: "不支持的格式",
              ratio: 1,
              status: "error",
              error: `仅支持 ${SUPPORTED_FORMAT_LABEL}`,
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
          const parsed = await parseBookFile(file, format, onProgress);
          const requestedPdfMode = pdfModes?.get(file) ?? "reflow";
          const readerMode =
            format === "pdf"
              ? selectImportedPdfMode(requestedPdfMode, parsed.chapters)
              : undefined;
          if (
            format === "pdf" &&
            requestedPdfMode === "reflow" &&
            readerMode === "original"
          ) {
            onProgress("无法生成完整重排文本，改用原版版面", 0.96);
          }
          const book: Book = {
            id: uid(),
            title: parsed.title,
            author: parsed.author,
            format,
            cover: parsed.cover,
            coverTone: toneForTitle(parsed.title),
            chapters: parsed.chapters,
            createdAt: Date.now(),
            progress: { chapterId: parsed.chapters[0]?.id ?? "", ratio: 0 },
            readerMode,
            pageCount: format === "pdf" ? parsed.pageCount : undefined,
          };
          let sourceFile: StoredFile | undefined;
          if (format === "pdf") {
            onProgress("保存原始文件", 0.97);
            sourceFile = {
              id: book.id,
              type: "pdf" as const,
              // IndexedDB 可直接结构化克隆 Blob，避免导入阶段再次读取整份 PDF。
              data: file,
            };
          }
          // 书目与原始 PDF 同一事务提交，失败时不会遗留孤儿文件。
          await putImportedBook(book, sourceFile);
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
      // 扫描件没有可供重排模式渲染的文字；拒绝写入会导致空白页的状态。
      if (selectImportedPdfMode(mode, book.chapters) !== mode) return false;
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
      emitEvent("note.created", {
        extId: note.id,
        title: note.title,
        content: note.content,
      });
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
    emitEvent("note.updated", {
      extId: updated.id,
      title: updated.title,
      content: updated.content,
    });
  }, []);

  const removeNote = useCallback(
    async (id: string) => {
      const linked = highlights.filter(item => item.noteId === id);
      await Promise.all(
        linked.map(async highlight => {
          if (isCitationOnlyHighlight(highlight)) {
            await dbDeleteHighlight(highlight.id);
            emitEvent("highlight.deleted", {
              extId: highlight.id,
              bookTitle:
                books.find(book => book.id === highlight.bookId)?.title ?? "",
            });
            return;
          }
          const unlinked = { ...highlight };
          delete unlinked.noteId;
          delete unlinked.citation;
          await putHighlight(unlinked);
          emitEvent("highlight.updated", {
            extId: highlight.id,
            noteId: null,
          });
        })
      );
      await dbDeleteNote(id);
      emitEvent("note.deleted", { extId: id });
      await reload();
      setRoute({ view: "notes" });
    },
    [books, highlights, reload]
  );

  const removeBook = useCallback(
    async (id: string) => {
      const book = books.find(item => item.id === id);
      const linkedAssociations = associationsForBook(associations, id);
      if (book) {
        const linked = highlights.filter(item => item.bookId === id);
        const updatedNotes = citationNoteUpdates(
          notes,
          linked,
          book.title,
          removeCitationBlocks
        );
        // deleteBook also removes all book highlights, so generated note blocks
        // must be removed first while their structured source still exists.
        await Promise.all(updatedNotes.map(putNote));
        for (const note of updatedNotes)
          emitEvent("note.updated", {
            extId: note.id,
            title: note.title,
            content: note.content,
          });
      }
      await dbDeleteBook(id);
      for (const association of linkedAssociations)
        emitEvent("association.deleted", { extId: association.id });
      if (book)
        emitEvent("book.deleted", { extId: book.id, title: book.title });
      await reload();
      setRoute({ view: "library" });
    },
    [associations, books, highlights, notes, reload]
  );

  const renameBook = useCallback(
    async (id: string, title: string) => {
      const t = title.trim();
      if (!t) return;
      const book = books.find(item => item.id === id);
      if (!book || book.title === t) return;

      const linked = highlights.filter(item => item.bookId === id);
      const updatedNotes = citationNoteUpdates(
        notes,
        linked,
        book.title,
        (content, descriptors) =>
          renameCitationBookTitles(content, descriptors, t)
      );
      const updated = { ...book, title: t };
      // Persist generated blocks before changing the title used to identify
      // them. Hand-written wiki-links are intentionally not rewritten.
      await Promise.all(updatedNotes.map(putNote));
      for (const note of updatedNotes)
        emitEvent("note.updated", {
          extId: note.id,
          title: note.title,
          content: note.content,
        });
      await putBook(updated);
      setNotes(current => {
        const replacements = new Map(updatedNotes.map(note => [note.id, note]));
        return current
          .map(note => replacements.get(note.id) ?? note)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      });
      setBooks(current =>
        current.map(item => (item.id === id ? updated : item))
      );
    },
    [books, highlights, notes]
  );

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

  const addAssociation = useCallback(
    async (
      source: PassageAnchor,
      target: PassageAnchor,
      options: AssociationOptions = {}
    ): Promise<Association> => {
      const direction = options.direction ?? "bidirectional";
      const pairKey = assertAssociationEndpoints(source, target, direction);
      const now = Date.now();
      const label = options.label?.trim();
      const candidate: Association = {
        id: uid(),
        source,
        target,
        direction,
        ...(label ? { label } : {}),
        pairKey,
        createdAt: now,
        updatedAt: now,
      };
      const { association, created } = await addAssociationIfAbsent(candidate);
      setAssociations(current => [
        association,
        ...current.filter(
          item =>
            item.id !== association.id && item.pairKey !== association.pairKey
        ),
      ]);
      if (created)
        emitEvent("association.created", associationEventSnapshot(association));
      return association;
    },
    []
  );

  const updateAssociation = useCallback(
    async (association: Association): Promise<Association> => {
      const current = associations.find(item => item.id === association.id);
      if (!current) throw new Error("关联不存在或已被删除");
      const pairKey = assertAssociationEndpoints(
        association.source,
        association.target,
        association.direction
      );
      const duplicate = associations.find(
        item => item.id !== association.id && item.pairKey === pairKey
      );
      if (duplicate) throw new Error("这两个文段已经存在相同方向的关联");

      const label = association.label?.trim();
      const updated: Association = {
        ...association,
        ...(label ? { label } : { label: undefined }),
        pairKey,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      };
      await putAssociation(updated);
      setAssociations(items =>
        items
          .map(item => (item.id === updated.id ? updated : item))
          .sort((left, right) => right.updatedAt - left.updatedAt)
      );
      emitEvent("association.updated", associationEventSnapshot(updated));
      return updated;
    },
    [associations]
  );

  const removeAssociation = useCallback(async (id: string) => {
    await dbDeleteAssociation(id);
    setAssociations(current => current.filter(item => item.id !== id));
    emitEvent("association.deleted", { extId: id });
  }, []);

  const unlinkCitation = useCallback(
    async (id: string, noteOverride?: Note) => {
      const highlight = highlights.find(item => item.id === id);
      if (!highlight?.noteId) return;

      const note =
        noteOverride?.id === highlight.noteId
          ? noteOverride
          : notes.find(item => item.id === highlight.noteId);
      const book = books.find(item => item.id === highlight.bookId);
      if (note) {
        const content = book
          ? removeCitationBlock(
              note.content,
              citationDescriptorForHighlight(highlight, book.title)
            )
          : note.content;
        // NoteEditor may pass an already-cleaned draft. It still needs to be
        // persisted even though a second removal is naturally a no-op.
        if (content !== note.content || noteOverride?.id === note.id) {
          const updatedNote = { ...note, content, updatedAt: Date.now() };
          await putNote(updatedNote);
          emitEvent("note.updated", {
            extId: updatedNote.id,
            title: updatedNote.title,
            content: updatedNote.content,
          });
          setNotes(current =>
            current
              .map(item => (item.id === note.id ? updatedNote : item))
              .sort((a, b) => b.updatedAt - a.updatedAt)
          );
        }
      }

      if (isCitationOnlyHighlight(highlight)) {
        await dbDeleteHighlight(id);
        setHighlights(current => current.filter(item => item.id !== id));
        emitEvent("highlight.deleted", {
          extId: id,
          bookTitle: book?.title ?? "",
        });
      } else {
        const unlinked = { ...highlight };
        delete unlinked.noteId;
        delete unlinked.citation;
        await putHighlight(unlinked);
        setHighlights(current =>
          current.map(item => (item.id === id ? unlinked : item))
        );
        emitEvent("highlight.updated", { extId: id, noteId: null });
      }
    },
    [books, highlights, notes]
  );

  const removeHighlight = useCallback(
    async (id: string) => {
      const highlight = highlights.find(item => item.id === id);
      if (highlight?.noteId) {
        const note = notes.find(item => item.id === highlight.noteId);
        const book = books.find(item => item.id === highlight.bookId);
        if (note && book) {
          const content = removeCitationBlock(
            note.content,
            citationDescriptorForHighlight(highlight, book.title)
          );
          if (content !== note.content) {
            const updatedNote = { ...note, content, updatedAt: Date.now() };
            // Keep the note and structured relationship consistent: if saving
            // the cleanup fails, do not delete the only remaining source key.
            await putNote(updatedNote);
            emitEvent("note.updated", {
              extId: updatedNote.id,
              title: updatedNote.title,
              content: updatedNote.content,
            });
            setNotes(current =>
              current
                .map(item => (item.id === note.id ? updatedNote : item))
                .sort((a, b) => b.updatedAt - a.updatedAt)
            );
          }
        }
      }
      await dbDeleteHighlight(id);
      setHighlights(current => current.filter(item => item.id !== id));
    },
    [books, highlights, notes]
  );

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
    associations,
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
    addAssociation,
    updateAssociation,
    removeAssociation,
    unlinkCitation,
    removeHighlight,
    saveMindMap,
    removeMindMap,
  };
}

export type Library = ReturnType<typeof useLibrary>;
