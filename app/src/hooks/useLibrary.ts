import { useCallback, useEffect, useState } from "react";
import type {
  Association,
  AssociationDirection,
  Book,
  Folder,
  FolderIconKey,
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
  deleteHighlightsWithCitationCleanup,
  deleteMindMap as dbDeleteMindMap,
  deleteNote as dbDeleteNote,
  deleteStudySet as dbDeleteStudySet,
  getAllAssociations,
  getAllBooks,
  getAllFolders,
  getAllMindMaps,
  getAllNotes,
  getAllStudySets,
  getDatabaseConnectionIssue,
  getFile,
  getHighlights,
  patchBookFolder,
  patchBookLastOpenedAt,
  patchBookMetadataWithNotes,
  patchBookOutline,
  patchBookProgress,
  patchBookCustomCover,
  patchBookReaderMode,
  patchFolderIcon,
  patchFolderName,
  putAssociation,
  putFolder,
  putHighlight,
  putImportedBook,
  putMindMap,
  putNote,
  putStudySet,
  subscribeDatabaseConnectionIssue,
  type DatabaseConnectionIssue,
  type StoredFile,
  uid,
} from "@/lib/db";
import { detectBookFormat, SUPPORTED_FORMAT_LABEL } from "@/lib/bookFormats";
import { parseBookFile } from "@/lib/parseBook";
import { toneForTitle } from "@/lib/covers";
import { seedIfEmpty } from "@/lib/seed";
import { emitEvent } from "@/lib/events";
import { mirrorImportTrayProgress, syncBookMirror } from "@/lib/mirrorSync";
import { selectImportedPdfMode } from "@/lib/pdfReaderState";
import { contentHashOfBook } from "@/lib/reading";
import {
  citationDescriptorForHighlight,
  isCitationOnlyHighlight,
  removeCitationBlock,
  renameCitationBookTitles,
} from "@/lib/citations";
import { assertAssociationEndpoints } from "@/lib/associations";
import type { EditableBookMetadata } from "@/lib/bookMetadata";
import {
  deleteHighlightWithMirror,
  deleteHighlightsWithMirror,
} from "@/lib/highlightDeletion";

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
  const [startupError, setStartupError] = useState<string | null>(null);
  const [databaseIssue, setDatabaseIssue] =
    useState<DatabaseConnectionIssue | null>(getDatabaseConnectionIssue);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
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

  useEffect(
    () =>
      subscribeDatabaseConnectionIssue(issue => {
        setDatabaseIssue(issue);
        if (issue) setReady(false);
      }),
    []
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await seedIfEmpty();
        await reload();
        if (!cancelled) setReady(true);
      } catch (reason) {
        if (cancelled) return;
        setStartupError(
          reason instanceof Error
            ? `本地书库初始化失败：${reason.message}`
            : "本地书库初始化失败，请重新加载后再试。"
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initializationAttempt, reload]);

  const retryInitialization = useCallback(() => {
    setReady(false);
    setStartupError(null);
    setInitializationAttempt(attempt => attempt + 1);
  }, []);

  const markBookOpened = useCallback((bookId: string) => {
    const openedAt = Date.now();
    setBooks(current =>
      current.map(book =>
        book.id === bookId ? { ...book, lastOpenedAt: openedAt } : book
      )
    );
    void patchBookLastOpenedAt(bookId, openedAt)
      .then(updated => {
        if (!updated) return;
        setBooks(current =>
          current.map(book =>
            book.id === bookId
              ? { ...book, lastOpenedAt: updated.lastOpenedAt }
              : book
          )
        );
      })
      .catch(error =>
        console.error("Failed to persist last opened time", error)
      );
  }, []);

  const navigate = useCallback(
    (r: Route) => {
      if (r.view === "reader" && r.bookId) markBookOpened(r.bookId);
      setRoute(r);
    },
    [markBookOpened]
  );

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
          const requestedPdfMode = pdfModes?.get(file) ?? "reflow";
          const parsed = await parseBookFile(file, format, onProgress, {
            pdfMode: requestedPdfMode,
          });
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
            outline: parsed.outline,
            createdAt: Date.now(),
            metadata: parsed.metadata,
            progress: { chapterId: parsed.chapters[0]?.id ?? "", ratio: 0 },
            readerMode,
            pageCount: format === "pdf" ? parsed.pageCount : undefined,
          };
          onProgress("计算内容指纹", 0.965);
          book.contentHash = await contentHashOfBook(book);
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
          try {
            await syncBookMirror(
              {
                extId: book.id,
                title: book.title,
                author: book.author,
                format: book.format,
                folder: book.folderId,
                contentHash: book.contentHash,
                metadata: book.metadata,
                chapters: book.chapters,
              },
              {
                onProgress: progress => {
                  const trayProgress = mirrorImportTrayProgress(progress);
                  setImports(current =>
                    current.map(task =>
                      task.id === taskId ? { ...task, ...trayProgress } : task
                    )
                  );
                },
              }
            );
          } catch (mirrorError) {
            const detail =
              mirrorError instanceof Error
                ? mirrorError.message
                : "未知镜像错误";
            setImports(current =>
              current.map(task =>
                task.id === taskId
                  ? {
                      ...task,
                      stage: "本地已保存，镜像失败",
                      ratio: 1,
                      status: "error",
                      error: `本地已保存，镜像失败：${detail}`,
                    }
                  : task
              )
            );
            continue;
          }
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
      const updated = await patchBookReaderMode(bookId, mode);
      if (!updated) return false;
      setBooks(current =>
        current.map(item =>
          item.id === bookId
            ? { ...item, readerMode: updated.readerMode }
            : item
        )
      );
      return true;
    },
    [books]
  );

  const dismissImport = useCallback((id: string) => {
    setImports(s => s.filter(t => t.id !== id));
  }, []);

  const openReader = useCallback(
    (bookId: string, chapterId?: string) => {
      navigate({ view: "reader", bookId, chapterId });
    },
    [navigate]
  );

  const saveProgress = useCallback(
    async (bookId: string, chapterId: string, ratio: number) => {
      const updated = await patchBookProgress(bookId, chapterId, ratio);
      if (!updated) return;
      // Merge just the field we own. A concurrent outline/cover edit may have
      // already reached React state after this IndexedDB transaction began.
      setBooks(current =>
        current.map(book =>
          book.id === bookId ? { ...book, progress: updated.progress } : book
        )
      );
    },
    []
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
      await emitEvent("note.created", {
        extId: note.id,
        title: note.title,
        content: note.content,
        updatedAt: note.updatedAt,
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
        navigate({ view: "reader", bookId: book.id });
        return;
      }
      let note = notes.find(n => n.title.toLowerCase() === lower);
      if (!note) note = await createNote(title.trim());
      setRoute({ view: "note", noteId: note.id });
    },
    [books, notes, createNote, navigate]
  );

  const saveNote = useCallback(async (note: Note) => {
    const updated = { ...note, updatedAt: Date.now() };
    await putNote(updated);
    setNotes(s =>
      s
        .map(n => (n.id === note.id ? updated : n))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    );
    await emitEvent("note.updated", {
      extId: updated.id,
      title: updated.title,
      content: updated.content,
      updatedAt: updated.updatedAt,
    });
  }, []);

  const removeNote = useCallback(
    async (id: string) => {
      const linked = highlights.filter(item => item.noteId === id);
      const citationOnly = linked.filter(isCitationOnlyHighlight);
      await deleteHighlightsWithMirror(
        citationOnly.map(highlight => ({
          id: highlight.id,
          bookTitle:
            books.find(book => book.id === highlight.bookId)?.title ?? "",
        })),
        {
          emitMirror: emitEvent,
          // Deleting the note clears every surviving noteExtId through the
          // server FK. Only after that authoritative transaction succeeds do
          // we atomically apply the equivalent local cascade.
          beforeLocalCommit: () => emitEvent("note.deleted", { extId: id }),
          commitLocal: () => dbDeleteNote(id),
        }
      );
      await reload();
      setRoute({ view: "notes" });
    },
    [books, highlights, reload]
  );

  const removeBook = useCallback(
    async (id: string) => {
      const book = books.find(item => item.id === id);
      if (book) {
        try {
          // Do not remove the browser's only copy until MySQL has committed
          // the complete server-side cascade. The event endpoint also emits
          // association.deleted WebHooks for rows removed by that cascade.
          await emitEvent("book.deleted", {
            extId: book.id,
            title: book.title,
          });
        } catch (cause) {
          throw new Error(
            "服务器未确认数据库删除，本地书籍仍然保留。请检查连接或登录状态后重试。",
            { cause }
          );
        }
        // deleteBook also removes all book highlights, so generated note blocks
        // are recomputed from the latest IndexedDB state in the same transaction.
        await dbDeleteBook(id);
      } else {
        await dbDeleteBook(id);
      }
      await reload();
      setRoute({ view: "library" });
    },
    [books, reload]
  );

  const updateBookMetadata = useCallback(
    async (id: string, values: EditableBookMetadata) => {
      const book = books.find(item => item.id === id);
      if (!book) throw new Error("找不到要编辑的书籍");

      const updatedNotes =
        book.title === values.title
          ? []
          : citationNoteUpdates(
              notes,
              highlights.filter(item => item.bookId === id),
              book.title,
              (content, descriptors) =>
                renameCitationBookTitles(content, descriptors, values.title)
            );
      try {
        // The server rewrites generated citation blocks and the book metadata
        // in one MySQL transaction; the local IndexedDB transaction mirrors
        // the same operation only after that commit succeeds.
        await emitEvent("book.updated", {
          extId: id,
          title: values.title,
          author: values.author,
          metadata: values.metadata,
        });
      } catch (cause) {
        throw new Error(
          "MySQL 镜像同步未完成，本地元数据尚未更改；可安全重试保存。",
          { cause }
        );
      }

      // Keep generated citation blocks aligned with a changed title. Manual
      // wiki-links remain untouched by design. Book and notes commit together.
      const updated = await patchBookMetadataWithNotes(
        id,
        values,
        updatedNotes
      );
      if (!updated) throw new Error("书籍已在其他窗口中删除");

      setNotes(current => {
        const replacements = new Map(updatedNotes.map(note => [note.id, note]));
        return current
          .map(note => replacements.get(note.id) ?? note)
          .sort((left, right) => right.updatedAt - left.updatedAt);
      });
      setBooks(current =>
        current.map(item =>
          item.id === id
            ? {
                ...item,
                title: updated.title,
                author: updated.author,
                metadata: updated.metadata,
              }
            : item
        )
      );
    },
    [books, highlights, notes]
  );

  const renameBook = useCallback(
    async (id: string, title: string) => {
      const book = books.find(item => item.id === id);
      if (!book) return;
      await updateBookMetadata(id, {
        title: title.trim(),
        author: book.author,
        metadata: book.metadata ?? { version: 1 },
      });
    },
    [books, updateBookMetadata]
  );

  const setBookCustomCover = useCallback(
    async (id: string, dataUrl?: string) => {
      const updated = await patchBookCustomCover(id, dataUrl);
      if (!updated) return;
      setBooks(current =>
        current.map(book =>
          book.id === id ? { ...book, customCover: updated.customCover } : book
        )
      );
    },
    []
  );

  const updateBookOutline = useCallback(
    async (id: string, outline: OutlineItem[]) => {
      const updated = await patchBookOutline(id, outline);
      if (!updated) return;
      setBooks(current =>
        current.map(item =>
          item.id === id ? { ...item, outline: updated.outline } : item
        )
      );
    },
    []
  );

  const moveBook = useCallback(
    async (id: string, folderId: string | undefined) => {
      const updated = await patchBookFolder(id, folderId);
      if (!updated) return;
      setBooks(current =>
        current.map(item => {
          if (item.id !== id) return item;
          const next = { ...item };
          if (updated.folderId) next.folderId = updated.folderId;
          else delete next.folderId;
          return next;
        })
      );
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
    const updated = await patchFolderName(id, t);
    if (!updated) return;
    setFolders(current =>
      current.map(folder =>
        folder.id === id ? { ...folder, name: updated.name } : folder
      )
    );
  }, []);

  const setFolderIcon = useCallback(async (id: string, icon: FolderIconKey) => {
    const updated = await patchFolderIcon(id, icon);
    if (!updated) return;
    setFolders(current =>
      current.map(folder =>
        folder.id === id ? { ...folder, icon: updated.icon } : folder
      )
    );
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

  const deleteHighlightEverywhere = useCallback(
    async (id: string) => {
      const highlight = highlights.find(item => item.id === id);
      const bookTitle = highlight
        ? (books.find(book => book.id === highlight.bookId)?.title ?? "")
        : "";
      const result = await deleteHighlightWithMirror(id, bookTitle, {
        emitMirror: emitEvent,
        commitLocal: ids => deleteHighlightsWithCitationCleanup(ids),
      });
      if (result.updatedNotes.length > 0) {
        const replacements = new Map(
          result.updatedNotes.map(note => [note.id, note])
        );
        setNotes(current =>
          current
            .map(note => replacements.get(note.id) ?? note)
            .sort((left, right) => right.updatedAt - left.updatedAt)
        );
      }
      const deleted = new Set(result.deletedHighlightIds);
      setHighlights(current =>
        current.filter(highlight => !deleted.has(highlight.id))
      );
    },
    [books, highlights]
  );

  const unlinkCitation = useCallback(
    async (id: string, noteOverride?: Note) => {
      const highlight = highlights.find(item => item.id === id);
      if (!highlight?.noteId) return;

      if (isCitationOnlyHighlight(highlight)) {
        await deleteHighlightEverywhere(id);
        return;
      }

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
          await emitEvent("note.updated", {
            extId: updatedNote.id,
            title: updatedNote.title,
            content: updatedNote.content,
            updatedAt: updatedNote.updatedAt,
          });
          setNotes(current =>
            current
              .map(item => (item.id === note.id ? updatedNote : item))
              .sort((a, b) => b.updatedAt - a.updatedAt)
          );
        }
      }

      const unlinked = { ...highlight };
      delete unlinked.noteId;
      delete unlinked.citation;
      await putHighlight(unlinked);
      setHighlights(current =>
        current.map(item => (item.id === id ? unlinked : item))
      );
      await emitEvent("highlight.updated", { extId: id, noteId: null });
    },
    [books, deleteHighlightEverywhere, highlights, notes]
  );

  const removeHighlight = useCallback(
    async (id: string) => {
      await deleteHighlightEverywhere(id);
    },
    [deleteHighlightEverywhere]
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
    initializationError: startupError ?? databaseIssue?.message ?? null,
    databaseIssue,
    retryInitialization,
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
    updateBookMetadata,
    setBookCustomCover,
    updateBookOutline,
    moveBook,
    createFolder,
    renameFolder,
    setFolderIcon,
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
