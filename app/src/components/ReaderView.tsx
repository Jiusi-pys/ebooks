import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Copy,
  List,
  ListPlus,
  MessageSquarePlus,
  Quote,
  Sparkles,
  Tag,
  Trash2,
  Eye,
  PenLine,
  GitBranch,
  X,
} from "lucide-react";
import { newReviewState } from "@/lib/srs";
import type { Library } from "@/hooks/useLibrary";
import type {
  Book,
  Highlight,
  HighlightStyle,
  OutlineItem,
  TypeSettings,
} from "@/types";
import {
  fontStack,
  loadTypeSettings,
  locateHighlight,
  quoteBlock,
  saveTypeSettings,
  segmentParagraph,
  swatch,
  themeById,
} from "@/lib/reading";
import { formatDate } from "@/lib/covers";
import { emitEvent } from "@/lib/events";
import { TypePanel } from "./reader/TypePanel";
import { SelectionToolbar } from "./reader/SelectionToolbar";
import { AiDrawer } from "./reader/AiDrawer";
import { CiteBrowser, type CitationTarget } from "./reader/CiteBrowser";
import {
  TranslationPopup,
  type TranslationLang,
} from "./reader/TranslationPopup";
import { PdfCanvasViewer, type PdfSelectInfo } from "./reader/PdfCanvasViewer";
import { SplitWorkspace } from "./reader/SplitWorkspace";
import {
  MAIN_READER_PANE,
  closeReferencePane,
  countReaderPanes,
  splitReaderPane,
  updateReferencePane,
  type ReaderPane,
  type SplitDirection,
} from "@/lib/splitLayout";
import { appendChild, createMindFromBook, newNode } from "@/lib/mind";
import { getSplitBooks } from "@/lib/splitScope";
import { addOutlineTarget, getBookOutline, outlineTitle } from "@/lib/outline";
import { OutlinePanel } from "./reader/OutlinePanel";

interface SelInfo {
  paraIndex: number;
  start: number;
  end: number;
  text: string;
  top: number;
  left: number;
}

interface HlPopup {
  id: string;
  top: number;
  left: number;
}

type PanelTab = "marks" | "notes" | "qa";
type ReadingPosture = "read" | "write" | "recall";

export function ReaderView({ lib, book }: { lib: Library; book: Book }) {
  const [type, setType] = useState<TypeSettings>(loadTypeSettings);
  const [showToc, setShowToc] = useState(true);
  const [showType, setShowType] = useState(false);
  const [sel, setSel] = useState<SelInfo | null>(null);
  const [hlPopup, setHlPopup] = useState<HlPopup | null>(null);
  const [aiTargetId, setAiTargetId] = useState<string | null>(null);
  const [showCite, setShowCite] = useState(false);
  const [translationSel, setTranslationSel] = useState<SelInfo | null>(null);
  const [tab, setTab] = useState<PanelTab>("marks");
  const [toast, setToast] = useState("");
  const [pdfSel, setPdfSel] = useState<PdfSelectInfo | null>(null);
  const [pdfAnchor, setPdfAnchor] = useState<string | null>(null);
  const [splitLayout, setSplitLayout] = useState<ReaderPane>(MAIN_READER_PANE);
  const [posture, setPosture] = useState<ReadingPosture>("read");
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const theme = themeById(type.themeId);
  const chapterId =
    lib.route.chapterId || book.progress.chapterId || book.chapters[0]?.id;
  const chapterIdx = Math.max(
    0,
    book.chapters.findIndex(c => c.id === chapterId)
  );
  const chapter = book.chapters[chapterIdx];
  /** 原版 PDF 版面模式（保留排版逐页阅读） */
  const isOriginal = book.format === "pdf" && book.readerMode === "original";

  const bookHighlights = useMemo(
    () => lib.highlights.filter(h => h.bookId === book.id),
    [lib.highlights, book.id]
  );

  /** 当前章节书摘 → 按段落归组定位 */
  const rangesByPara = useMemo(() => {
    const map = new Map<
      number,
      { h: Highlight; start: number; end: number }[]
    >();
    if (!chapter) return map;
    for (const h of lib.highlights) {
      if (h.chapterId !== chapter.id) continue;
      const loc = locateHighlight(chapter, h);
      if (!loc) continue;
      const arr = map.get(loc.paraIndex) ?? [];
      arr.push({ h, start: loc.start, end: loc.end });
      map.set(loc.paraIndex, arr);
    }
    return map;
  }, [lib.highlights, chapter]);

  const aiTarget = aiTargetId
    ? (lib.highlights.find(h => h.id === aiTargetId) ?? null)
    : null;
  const activeStudySet = lib.route.studySetId
    ? lib.studySets.find(set => set.id === lib.route.studySetId)
    : undefined;
  const splitBooks = getSplitBooks(lib.books, book, activeStudySet);

  useEffect(() => saveTypeSettings(type), [type]);

  // 切章：回顶部 + 记录进度
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setSel(null);
    setHlPopup(null);
    if (chapter) lib.saveProgress(book.id, chapter.id, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id]);

  // 锚点跳转：滚动到书摘段落并闪烁
  useEffect(() => {
    const hid = lib.route.highlightId;
    if (!hid || !chapter) return;
    const h = lib.highlights.find(x => x.id === hid);
    if (!h || h.chapterId !== chapter.id) return;
    const loc = locateHighlight(chapter, h);
    if (!loc) return;
    requestAnimationFrame(() => {
      const el = wrapRef.current?.querySelector(`[data-pi="${loc.paraIndex}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.classList.add("anchor-flash");
      window.setTimeout(() => el?.classList.remove("anchor-flash"), 2400);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.route.highlightId, chapter?.id]);

  // 自定义目录：可精确跳到章节内的正文段落。
  useEffect(() => {
    const paraIndex = lib.route.outlineParaIndex;
    if (paraIndex === undefined || !chapterId) return;
    requestAnimationFrame(() => {
      const el = wrapRef.current?.querySelector(`[data-pi="${paraIndex}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.classList.add("anchor-flash");
      window.setTimeout(() => el?.classList.remove("anchor-flash"), 2400);
    });
  }, [lib.route.outlineParaIndex, lib.route.outlineNavigationKey, chapterId]);

  // 原版模式：「回到原文」→ 按书摘文字定位 PDF 页
  useEffect(() => {
    if (!isOriginal) return;
    const hid = lib.route.highlightId;
    if (!hid) return;
    const h = lib.highlights.find(x => x.id === hid);
    if (h) setPdfAnchor(h.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.route.highlightId, isOriginal]);

  const pdfSaveTimer = useRef<number | null>(null);
  /** 原版模式进度：页码 / 总页数 → 沿用 progress.ratio */
  const onPdfProgress = useCallback(
    (page: number, pageCount: number) => {
      if (pdfSaveTimer.current) window.clearTimeout(pdfSaveTimer.current);
      pdfSaveTimer.current = window.setTimeout(() => {
        if (chapter)
          lib.saveProgress(
            book.id,
            chapter.id,
            pageCount > 0 ? page / pageCount : 0
          );
      }, 500);
    },
    [book.id, chapter, lib]
  );

  /** 原版模式划选 → 生成书摘 */
  const createFromPdf = useCallback(
    async (info: PdfSelectInfo, extra: Partial<Highlight>) => {
      if (!chapter) return;
      const chapterTitle = `${chapter.title} · 第 ${info.page} 页`;
      const h = await lib.addHighlight({
        bookId: book.id,
        chapterId: chapter.id,
        chapterTitle,
        text: info.text,
        paraIndex: 0,
        start: 0,
        end: info.text.length,
        ...extra,
      });
      emitEvent("highlight.created", {
        extId: h.id,
        bookExtId: book.id,
        bookTitle: book.title,
        chapterTitle,
        text: h.text,
        styleKind: h.style?.kind ?? "underline",
        styleColor: h.style?.color ?? "orange",
        note: h.note,
      });
      window.getSelection()?.removeAllRanges();
      setPdfSel(null);
    },
    [chapter, book.id, book.title, lib]
  );

  const saveTimer = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const el = scrollRef.current;
      if (!el || !chapter) return;
      const max = el.scrollHeight - el.clientHeight;
      lib.saveProgress(
        book.id,
        chapter.id,
        max > 0 ? Math.min(1, el.scrollTop / max) : 1
      );
    }, 400);
  }, [book.id, chapter, lib]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1800);
  }, []);

  /* ---------- 划选 ---------- */

  const onMouseUp = useCallback(() => {
    setHlPopup(null);
    setTranslationSel(null);
    const s = window.getSelection();
    const wrap = wrapRef.current;
    if (!s || s.isCollapsed || !wrap) {
      setSel(null);
      return;
    }
    const range = s.getRangeAt(0);
    const closestP = (n: Node | null): Element | null => {
      if (!n) return null;
      const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
      return el?.closest("[data-pi]") ?? null;
    };
    const pa = closestP(range.startContainer);
    const pb = closestP(range.endContainer);
    if (!pa || pa !== pb || !wrap.contains(pa)) {
      setSel(null);
      return;
    }
    const text = range.toString();
    if (text.trim().length < 2) {
      setSel(null);
      return;
    }
    const pre = range.cloneRange();
    pre.selectNodeContents(pa);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const rect = range.getBoundingClientRect();
    const wrect = wrap.getBoundingClientRect();
    setSel({
      paraIndex: Number(pa.getAttribute("data-pi")),
      start,
      end: start + text.length,
      text,
      top: rect.top - wrect.top - 10,
      left: rect.left - wrect.left + rect.width / 2,
    });
  }, []);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  const createFromSelection = useCallback(
    async (extra: Partial<Highlight>): Promise<Highlight | null> => {
      if (!sel || !chapter) return null;
      const h = await lib.addHighlight({
        bookId: book.id,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        text: sel.text,
        paraIndex: sel.paraIndex,
        start: sel.start,
        end: sel.end,
        ...extra,
      });
      emitEvent("highlight.created", {
        extId: h.id,
        bookExtId: book.id,
        bookTitle: book.title,
        chapterTitle: chapter.title,
        text: h.text,
        styleKind: h.style?.kind ?? "underline",
        styleColor: h.style?.color ?? "orange",
        note: h.note,
      });
      clearSelection();
      return h;
    },
    [sel, chapter, book.id, book.title, lib]
  );

  const addMark = useCallback(
    async (style: HighlightStyle) => {
      const h = await createFromSelection({ style });
      if (h) showToast("已划线");
    },
    [createFromSelection, showToast]
  );

  const addComment = useCallback(
    async (note: string, name: string) => {
      const h = await createFromSelection({
        style: { kind: "background", color: "yellow" },
        note,
        ...(name ? { name } : {}),
      });
      if (h) {
        showToast("批注已保存");
        setTab("notes");
      }
    },
    [createFromSelection, showToast]
  );

  const saveOutlineTarget = useCallback(
    async (target: { chapterId: string; paraIndex: number; title: string }) => {
      const outline = addOutlineTarget(getBookOutline(book), {
        id: `outline:${crypto.randomUUID()}`,
        title: outlineTitle(target.title),
        chapterId: target.chapterId,
        paraIndex: target.paraIndex,
      });
      await lib.updateBookOutline(book.id, outline);
      showToast("已加入导航目录");
    },
    [book, lib, showToast]
  );

  const addSelectionToOutline = useCallback(async () => {
    if (!sel || !chapter) return;
    await saveOutlineTarget({
      chapterId: chapter.id,
      paraIndex: sel.paraIndex,
      title: sel.text,
    });
    clearSelection();
  }, [sel, chapter, saveOutlineTarget]);

  const addHighlightToOutline = useCallback(
    async (highlight: Highlight) => {
      const sourceChapter = book.chapters.find(
        item => item.id === highlight.chapterId
      );
      if (!sourceChapter) return;
      const location = locateHighlight(sourceChapter, highlight);
      await saveOutlineTarget({
        chapterId: highlight.chapterId,
        paraIndex: location?.paraIndex ?? highlight.paraIndex ?? 0,
        title: highlight.name || highlight.text,
      });
      setHlPopup(null);
    },
    [book.chapters, saveOutlineTarget]
  );

  const openTranslation = useCallback(() => {
    if (!sel) return;
    setTranslationSel(sel);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }, [sel]);

  /** 把译文保存成带名称的批注，仍锚定在原文位置 */
  const saveTranslation = useCallback(
    async (translation: string, targetLang: TranslationLang) => {
      const s = translationSel;
      if (!s || !chapter) return;
      const h = await lib.addHighlight({
        bookId: book.id,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        text: s.text,
        paraIndex: s.paraIndex,
        start: s.start,
        end: s.end,
        style: { kind: "background", color: "blue" },
        name: `译文 · ${targetLang}`,
        note: translation,
      });
      emitEvent("highlight.created", {
        extId: h.id,
        bookExtId: book.id,
        bookTitle: book.title,
        chapterTitle: chapter.title,
        text: h.text,
        styleKind: "background",
        styleColor: "blue",
        note: translation,
        name: h.name,
      });
      emitEvent("translation.created", {
        extId: h.id,
        bookExtId: book.id,
        bookTitle: book.title,
        chapterTitle: chapter.title,
        targetLang,
        scope: "passage",
        text: translation,
        sourceLength: s.text.length,
      });
      showToast("译文已存为批注");
      setTab("notes");
    },
    [translationSel, chapter, book.id, book.title, lib, showToast]
  );

  /** 三级引用：从任意书/章节/文段创建书摘并引用到笔记 */
  const citePassage = useCallback(
    async (t: CitationTarget, noteId: string | "new") => {
      const h = await lib.addHighlight({
        bookId: t.bookId,
        chapterId: t.chapterId,
        chapterTitle: t.chapterTitle,
        text: t.text,
        paraIndex: t.paraIndex,
        start: 0,
        end: t.text.length,
        style: { kind: "underline", color: "orange" },
      });
      emitEvent("highlight.created", {
        extId: h.id,
        bookExtId: t.bookId,
        bookTitle: t.bookTitle,
        chapterTitle: t.chapterTitle,
        text: h.text,
        styleKind: "underline",
        styleColor: "orange",
      });
      const block = quoteBlock(t.bookTitle, t.chapterTitle, t.text);
      if (noteId === "new") {
        const note = await lib.createNote(`《${t.bookTitle}》书摘`);
        await lib.saveNote({ ...note, content: block });
        await lib.updateHighlight({ ...h, noteId: note.id });
        emitEvent("note.created", { extId: note.id, title: note.title });
        showToast(`已引用《${t.bookTitle}》的文段到新笔记`);
      } else {
        const note = lib.notes.find(n => n.id === noteId);
        if (!note) return;
        await lib.saveNote({
          ...note,
          content: note.content.replace(/\s*$/, "\n\n") + block,
        });
        await lib.updateHighlight({ ...h, noteId });
        emitEvent("note.updated", { extId: noteId, title: note.title });
        showToast(`已引用到「${note.title}」`);
      }
      emitEvent("highlight.updated", { extId: h.id });
      setShowCite(false);
    },
    [lib, showToast]
  );

  const askAiOn = useCallback(
    async (existing?: Highlight) => {
      if (existing) {
        setAiTargetId(existing.id);
        setHlPopup(null);
        return;
      }
      const h = await createFromSelection({
        style: { kind: "none", color: "orange" },
      });
      if (h) setAiTargetId(h.id);
    },
    [createFromSelection]
  );

  const onSaveQa = useCallback(
    (qa: { q: string; a: string; ts: number }) => {
      const t = lib.highlights.find(h => h.id === aiTargetId);
      if (!t) return;
      const aiQa = [...(t.aiQa ?? []), qa];
      lib.updateHighlight({ ...t, aiQa });
      emitEvent("qa.recorded", {
        extId: t.id,
        bookTitle: book.title,
        question: qa.q,
        aiQa,
      });
    },
    [lib, aiTargetId, book.title]
  );

  const addToMindMap = useCallback(
    async (
      source: Highlight,
      title = source.name || source.text.slice(0, 36)
    ) => {
      const sourceChapter = book.chapters.find(
        item => item.id === source.chapterId
      );
      if (!sourceChapter) return;
      let map =
        lib.mindMaps.find(item => item.bookId === book.id) ??
        createMindFromBook(book);
      const alreadyLinked = (node: import("@/types").MindNode): boolean =>
        node.sourceHighlightId === source.id ||
        node.children.some(alreadyLinked);
      if (alreadyLinked(map.root)) {
        showToast("这张卡片已在脑图中");
        return;
      }
      let root = map.root;
      let parent =
        root.children.find(node => node.chapterId === source.chapterId) ?? null;
      if (!parent) {
        const chapterNode = newNode(sourceChapter.title, source.chapterId);
        root = appendChild(root, root.id, chapterNode);
        parent = chapterNode;
      }
      root = appendChild(root, parent.id, {
        ...newNode(title, source.chapterId),
        sourceHighlightId: source.id,
      });
      map = { ...map, root };
      await lib.saveMindMap(map);
      emitEvent("mindmap.updated", {
        extId: map.id,
        bookExtId: book.id,
        root: map.root,
      });
      showToast("卡片已加入脑图");
    },
    [book, lib, showToast]
  );

  /** MarginNote 式统一卡片：一次生成，同时更新摘录、复习队列和脑图节点。 */
  const applyStudyCard = useCallback(
    async (card: {
      title: string;
      note: string;
      cloze: string[];
      tags: string[];
    }) => {
      const source = lib.highlights.find(h => h.id === aiTargetId);
      if (!source || !chapter) return;
      const qa = {
        q: "把这段内容制作成复习卡",
        a: `已生成「${card.title}」，并加入脑图与复习队列。`,
        ts: Date.now(),
      };
      const updated: Highlight = {
        ...source,
        name: card.title,
        note: card.note,
        cloze: card.cloze.length ? card.cloze : undefined,
        tags: Array.from(
          new Set([...(source.tags ?? []), ...card.tags, "AI 制卡"])
        ),
        review: source.review ?? newReviewState(),
        aiQa: [...(source.aiQa ?? []), qa],
      };
      await lib.updateHighlight(updated);
      await addToMindMap(updated, card.title);
      emitEvent("review.updated", {
        extId: source.id,
        inReview: true,
        review: updated.review,
      });
      emitEvent("highlight.updated", {
        extId: source.id,
        name: card.title,
        tags: updated.tags,
        cloze: updated.cloze,
      });
      showToast("AI 卡片已加入脑图和复习");
    },
    [aiTargetId, chapter, lib, addToMindMap, showToast]
  );

  /** 引用本书的笔记（含 [[书名]] 双链） */
  const citingNotes = useMemo(
    () =>
      lib.notes.filter(n =>
        n.content.toLowerCase().includes(`[[${book.title.toLowerCase()}]]`)
      ),
    [lib.notes, book.title]
  );

  if (!chapter) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        这本书没有可显示的章节（可能是纯扫描版 PDF，无文字层）。
      </div>
    );
  }

  const gotoChapter = (idx: number) => {
    const c = book.chapters[idx];
    if (c)
      lib.navigate({
        view: "reader",
        bookId: book.id,
        chapterId: c.id,
        studySetId: activeStudySet?.id,
      });
  };

  const gotoOutline = (item: OutlineItem) => {
    if (!item.chapterId) return;
    if (item.chapterId === chapter.id && item.paraIndex === undefined) {
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
    lib.navigate({
      view: "reader",
      bookId: book.id,
      chapterId: item.chapterId,
      studySetId: activeStudySet?.id,
      outlineParaIndex: item.paraIndex,
      outlineNavigationKey: Date.now(),
    });
  };

  /** PDF：切换 重排 / 原版 阅读方式 */
  const toggleReaderMode = async () => {
    const target = isOriginal ? "reflow" : "original";
    const ok = await lib.setReaderMode(book.id, target);
    if (!ok) {
      showToast("未找到原始 PDF 文件，无法切换");
      return;
    }
    showToast(target === "original" ? "已切换为原版版面" : "已切换为重排文本");
  };

  /** 新窗格默认打开本书下一章，便于前后对照。 */
  const splitPane = (paneId: string, direction: SplitDirection) => {
    if (posture !== "read" || aiTarget) {
      showToast("请先回到阅读模式并关闭 AI 面板");
      return;
    }
    setSplitLayout(current =>
      splitReaderPane(current, paneId, direction, {
        bookId: book.id,
        chapterId: book.chapters[chapterIdx + 1]?.id ?? chapter?.id ?? "",
      })
    );
  };

  const paneCount = countReaderPanes(splitLayout);
  const visibleSplitLayout =
    posture === "read" && !aiTarget ? splitLayout : MAIN_READER_PANE;

  const panelMarks = bookHighlights.filter(
    h => (h.style?.kind ?? "underline") !== "none"
  );
  const panelNotes = bookHighlights.filter(h => h.note);
  const panelQa = bookHighlights.filter(h => (h.aiQa?.length ?? 0) > 0);
  const popupHl = hlPopup
    ? (lib.highlights.find(h => h.id === hlPopup.id) ?? null)
    : null;

  return (
    <div
      className="reader-shell flex h-full"
      style={{ background: theme.bg, color: theme.text }}
    >
      {/* 章节目录（原版模式下由 PDF 大纲代替） */}
      {showToc && posture === "read" && !isOriginal && (
        <OutlinePanel
          book={book}
          activeChapterId={chapter.id}
          theme={theme}
          onNavigate={gotoOutline}
          onChange={outline => void lib.updateBookOutline(book.id, outline)}
        />
      )}

      {/* 可递归拆分的阅读工作区 */}
      <div className="min-h-0 min-w-0 flex-1">
        <SplitWorkspace
          node={visibleSplitLayout}
          books={splitBooks}
          theme={theme}
          type={type}
          canSplit={paneCount < 4}
          scopeLabel={
            activeStudySet ? `学习集：${activeStudySet.name}` : "全书架"
          }
          showMainSplitControls={!showCite && !showType}
          onSplit={splitPane}
          onChange={(paneId, target) =>
            setSplitLayout(current =>
              updateReferencePane(current, paneId, target)
            )
          }
          onClose={paneId =>
            setSplitLayout(current => closeReferencePane(current, paneId))
          }
          main={
            <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
              {/* 顶栏 */}
              <div
                className="flex h-12 shrink-0 items-center gap-2 border-b px-4"
                style={{ borderColor: theme.border }}
              >
                <button
                  onClick={() =>
                    lib.navigate(
                      activeStudySet
                        ? { view: "studyset", studySetId: activeStudySet.id }
                        : { view: "library" }
                    )
                  }
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] hover:opacity-70"
                  style={{ color: theme.muted }}
                >
                  <ArrowLeft size={15} /> {activeStudySet ? "学习集" : "书架"}
                </button>
                {!isOriginal && (
                  <button
                    onClick={() => setShowToc(v => !v)}
                    className="rounded-md p-1.5 hover:opacity-70"
                    style={{ color: theme.muted }}
                    title="目录"
                  >
                    <List size={16} />
                  </button>
                )}
                {/* PDF：重排 / 原版切换 */}
                {book.format === "pdf" && (
                  <button
                    onClick={() => void toggleReaderMode()}
                    className="flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-opacity hover:opacity-70"
                    style={{ borderColor: theme.border, color: theme.muted }}
                    title={
                      isOriginal
                        ? "切换为重排文本（可调整字号）"
                        : "切换为原版版面（保留 PDF 排版）"
                    }
                  >
                    <BookOpenText size={12} />
                    {isOriginal ? "原版" : "重排"}
                  </button>
                )}
                <div
                  className="flex overflow-hidden rounded-full border"
                  style={{ borderColor: theme.border }}
                >
                  {(
                    [
                      ["read", "阅读", BookOpenText],
                      ["write", "沉浸", PenLine],
                      ["recall", "回忆", Eye],
                    ] as const
                  ).map(([mode, label, Icon]) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setPosture(mode);
                        setHlPopup(null);
                        setSel(null);
                      }}
                      className={`flex items-center gap-1 px-2.5 py-1 text-[11px] ${
                        posture === mode
                          ? "bg-primary text-primary-foreground"
                          : ""
                      }`}
                      style={
                        posture === mode ? undefined : { color: theme.muted }
                      }
                      title={
                        mode === "recall"
                          ? "隐藏摘录，点击模糊文字揭示答案"
                          : undefined
                      }
                    >
                      <Icon size={10} /> {label}
                    </button>
                  ))}
                </div>
                <div
                  className="min-w-0 flex-1 truncate text-center text-[13px]"
                  style={{ color: theme.muted }}
                >
                  <span
                    className="font-reading font-medium"
                    style={{ color: theme.text }}
                  >
                    {book.title}
                  </span>
                  <span className="font-meta mx-2 text-[10px]">·</span>
                  {isOriginal ? "原版版面" : chapter.title}
                </div>
                {/* 引用按钮（三级选择：书 → 章节 → 文段） */}
                <div className="relative">
                  <button
                    onClick={() => setShowCite(v => !v)}
                    className={`flex items-center gap-1 rounded-full border px-3 py-1 text-[12.5px] transition-colors ${
                      showCite ? "border-primary text-primary" : ""
                    }`}
                    style={{
                      borderColor: showCite ? undefined : theme.border,
                      color: showCite ? undefined : theme.muted,
                    }}
                  >
                    <Quote size={12} /> 引用
                  </button>
                  {showCite && (
                    <div className="absolute right-0 top-9">
                      <CiteBrowser
                        books={lib.books}
                        currentBookId={book.id}
                        notes={lib.notes}
                        onSelect={citePassage}
                        onClose={() => setShowCite(false)}
                      />
                    </div>
                  )}
                </div>
                {/* 排版按钮（原版版面下无效，隐藏） */}
                {!isOriginal && (
                  <div className="relative">
                    <button
                      onClick={() => setShowType(v => !v)}
                      className={`flex items-center gap-1 rounded-full border px-3 py-1 text-[12.5px] transition-colors ${
                        showType ? "border-primary text-primary" : ""
                      }`}
                      style={{
                        borderColor: showType ? undefined : theme.border,
                        color: showType ? undefined : theme.muted,
                      }}
                    >
                      <span className="text-[11px]">A</span>
                      <span className="font-reading text-[15px] leading-none">
                        文
                      </span>
                    </button>
                    {showType && (
                      <TypePanel
                        value={type}
                        onChange={setType}
                        onClose={() => setShowType(false)}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* 正文：原版 PDF 或重排文本 */}
              {isOriginal ? (
                <div className="relative min-h-0 flex-1">
                  <PdfCanvasViewer
                    key={book.id}
                    bookId={book.id}
                    initialPage={Math.max(
                      1,
                      Math.round(
                        (book.progress?.ratio ?? 0) * (book.pageCount ?? 1)
                      )
                    )}
                    onProgress={onPdfProgress}
                    onSelectText={setPdfSel}
                    anchorText={pdfAnchor}
                    onAnchorConsumed={() => {
                      setPdfAnchor(null);
                      lib.navigate({ view: "reader", bookId: book.id });
                    }}
                  />

                  {/* 原版模式划选弹层 */}
                  {pdfSel && (
                    <div
                      className="float-pop fixed z-50 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-card p-1 shadow-xl"
                      style={{
                        left: pdfSel.x,
                        top: Math.max(8, pdfSel.y - 46),
                      }}
                    >
                      <button
                        onClick={() => {
                          void createFromPdf(pdfSel, {
                            style: { kind: "underline", color: "orange" },
                          });
                          showToast("已划线");
                        }}
                        className="rounded-full px-2.5 py-1 text-[12px] hover:bg-accent"
                      >
                        划线
                      </button>
                      <button
                        onClick={() => {
                          const note = window.prompt("批注内容");
                          if (note != null && note.trim()) {
                            void createFromPdf(pdfSel, {
                              style: { kind: "background", color: "yellow" },
                              note: note.trim(),
                            });
                            showToast("批注已保存");
                            setTab("notes");
                          }
                        }}
                        className="rounded-full px-2.5 py-1 text-[12px] hover:bg-accent"
                      >
                        批注
                      </button>
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(pdfSel.text);
                          window.getSelection()?.removeAllRanges();
                          setPdfSel(null);
                          showToast("已复制");
                        }}
                        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] hover:bg-accent"
                      >
                        <Copy size={11} /> 复制
                      </button>
                      <button
                        onClick={() => {
                          window.getSelection()?.removeAllRanges();
                          setPdfSel(null);
                        }}
                        className="rounded-full p-1 text-muted-foreground hover:bg-accent"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}

                  {toast && (
                    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-1.5 text-xs text-background shadow-lg">
                      {toast}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  ref={scrollRef}
                  className="relative flex-1 overflow-y-auto"
                  onScroll={onScroll}
                >
                  <div
                    ref={wrapRef}
                    className="relative mx-auto px-8 pb-28 pt-12"
                    style={{ maxWidth: type.columns === 2 ? 1080 : 680 }}
                    onMouseUp={onMouseUp}
                  >
                    <h1 className="font-reading mb-2 text-center text-[26px] font-bold tracking-wide">
                      {chapter.title}
                    </h1>
                    <div
                      className="font-meta mb-10 text-center text-[10.5px] uppercase tracking-[0.2em]"
                      style={{ color: theme.muted }}
                    >
                      {book.title} · {chapterIdx + 1} / {book.chapters.length}
                    </div>
                    <div
                      className={`reader-body${type.columns === 2 ? " cols-2" : ""}`}
                      style={{
                        fontFamily: fontStack(type.fontId),
                        fontSize: type.fontSize,
                        lineHeight: type.lineHeight,
                        letterSpacing: `${type.letterSpacing}em`,
                        fontWeight: type.fontWeight,
                      }}
                    >
                      {chapter.paragraphs.map((p, i) => (
                        <Paragraph
                          key={i}
                          index={i}
                          text={p}
                          ranges={rangesByPara.get(i) ?? []}
                          recall={posture === "recall"}
                          onSegmentClick={(hid, top, left) =>
                            setHlPopup({ id: hid, top, left })
                          }
                        />
                      ))}
                    </div>

                    {/* 章末导航 */}
                    <div
                      className="mt-16 flex items-center justify-between border-t pt-6"
                      style={{ borderColor: theme.border }}
                    >
                      <button
                        disabled={chapterIdx === 0}
                        onClick={() => gotoChapter(chapterIdx - 1)}
                        className="flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[13px] transition-opacity disabled:opacity-30"
                        style={{
                          borderColor: theme.border,
                          color: theme.muted,
                        }}
                      >
                        <ChevronLeft size={14} /> 上一章
                      </button>
                      <span
                        className="font-meta text-[11px]"
                        style={{ color: theme.muted }}
                      >
                        {Math.round(
                          ((chapterIdx + 1) / book.chapters.length) * 100
                        )}
                        %
                      </span>
                      <button
                        disabled={chapterIdx >= book.chapters.length - 1}
                        onClick={() => gotoChapter(chapterIdx + 1)}
                        className="flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[13px] transition-opacity disabled:opacity-30"
                        style={{
                          borderColor: theme.border,
                          color: theme.muted,
                        }}
                      >
                        下一章 <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>

                  {/* 划选工具条 */}
                  {sel && (
                    <SelectionToolbar
                      top={sel.top}
                      left={sel.left}
                      onHighlight={addMark}
                      onComment={addComment}
                      onOpenCiteBrowser={() => setShowCite(true)}
                      onTranslate={openTranslation}
                      onAddToOutline={() => void addSelectionToOutline()}
                      onAskAi={() => askAiOn()}
                      onClose={() => setSel(null)}
                    />
                  )}

                  {/* 划选即时翻译 */}
                  {translationSel && (
                    <TranslationPopup
                      top={translationSel.top + 42}
                      left={translationSel.left}
                      sourceText={translationSel.text}
                      bookTitle={book.title}
                      chapterTitle={chapter.title}
                      theme={theme}
                      onSave={(translation, targetLang) =>
                        void saveTranslation(translation, targetLang)
                      }
                      onClose={() => setTranslationSel(null)}
                    />
                  )}

                  {/* 已有书摘的点击弹层 */}
                  {popupHl && hlPopup && (
                    <HighlightPopup
                      key={popupHl.id + String(popupHl.aiQa?.length ?? 0)}
                      h={popupHl}
                      top={hlPopup.top}
                      left={hlPopup.left}
                      onEditNote={text => {
                        lib.updateHighlight({ ...popupHl, note: text });
                        emitEvent("highlight.updated", {
                          extId: popupHl.id,
                          note: text,
                        });
                      }}
                      onEditName={name => {
                        lib.updateHighlight({
                          ...popupHl,
                          name: name || undefined,
                        });
                        emitEvent("highlight.updated", {
                          extId: popupHl.id,
                          name,
                        });
                      }}
                      onEditTags={tags => {
                        lib.updateHighlight({
                          ...popupHl,
                          tags: tags.length > 0 ? tags : undefined,
                        });
                        emitEvent("highlight.tagged", {
                          extId: popupHl.id,
                          tags,
                        });
                      }}
                      onEditCloze={cloze => {
                        lib.updateHighlight({
                          ...popupHl,
                          cloze: cloze.length > 0 ? cloze : undefined,
                        });
                        emitEvent("highlight.updated", {
                          extId: popupHl.id,
                          cloze,
                        });
                      }}
                      onToggleReview={() => {
                        const next = popupHl.review
                          ? undefined
                          : newReviewState();
                        lib.updateHighlight({ ...popupHl, review: next });
                        emitEvent("review.updated", {
                          extId: popupHl.id,
                          inReview: !popupHl.review,
                          due: next?.due,
                          review: next,
                        });
                      }}
                      onAddToMindMap={() => void addToMindMap(popupHl)}
                      onAddToOutline={() => void addHighlightToOutline(popupHl)}
                      onCitePassage={citePassage}
                      onAskAi={() => askAiOn(popupHl)}
                      onDelete={() => {
                        lib.removeHighlight(popupHl.id);
                        emitEvent("highlight.deleted", {
                          extId: popupHl.id,
                          bookTitle: book.title,
                        });
                        setHlPopup(null);
                      }}
                      onClose={() => setHlPopup(null)}
                      notes={lib.notes}
                      books={lib.books}
                      currentBookId={book.id}
                    />
                  )}

                  {toast && (
                    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-1.5 text-xs text-background shadow-lg">
                      {toast}
                    </div>
                  )}
                </div>
              )}
            </div>
          }
        />
      </div>

      {/* 右侧：AI 抽屉 或 书摘面板 */}
      {aiTarget ? (
        <AiDrawer
          book={book}
          chapter={chapter}
          target={aiTarget}
          theme={theme}
          onSaveQa={onSaveQa}
          onApplyStudyCard={applyStudyCard}
          onClose={() => setAiTargetId(null)}
        />
      ) : posture === "read" ? (
        <div
          className="hidden w-72 shrink-0 flex-col border-l xl:flex"
          style={{ background: theme.panel, borderColor: theme.border }}
        >
          <div
            className="flex shrink-0 border-b"
            style={{ borderColor: theme.border }}
          >
            {(
              [
                ["marks", `书摘 ${panelMarks.length}`],
                ["notes", `批注 ${panelNotes.length}`],
                ["qa", `问答 ${panelQa.length}`],
              ] as [PanelTab, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 text-[12px] ${tab === t ? "font-medium" : ""}`}
                style={{
                  color: tab === t ? theme.text : theme.muted,
                  borderBottom:
                    tab === t ? "2px solid #f54001" : "2px solid transparent",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {tab === "marks" &&
              (panelMarks.length === 0 ? (
                <PanelEmpty text="选中正文即可划线：下划线、背景色、字色三种样式五种颜色。" />
              ) : (
                panelMarks.map(h => (
                  <MarkCard
                    key={h.id}
                    h={h}
                    onLocate={() =>
                      lib.navigate({
                        view: "reader",
                        bookId: book.id,
                        chapterId: h.chapterId,
                        highlightId: h.id,
                      })
                    }
                    onAskAi={() => setAiTargetId(h.id)}
                  />
                ))
              ))}
            {tab === "notes" &&
              (panelNotes.length === 0 ? (
                <PanelEmpty text="选中文字后点「批注」，在文段旁直接写下想法，不打断阅读。" />
              ) : (
                panelNotes.map(h => (
                  <div
                    key={h.id}
                    className="mb-3 rounded-md p-3 shadow-sm"
                    style={{ background: theme.bg }}
                  >
                    {h.name && (
                      <div className="font-meta mb-1 text-[10px] uppercase tracking-wider text-primary">
                        {h.name}
                      </div>
                    )}
                    <p className="font-reading text-[12.5px] leading-6 opacity-70">
                      「{h.text}」
                    </p>
                    <p className="mt-2 text-[13px] leading-6">{h.note}</p>
                    <div
                      className="font-meta mt-2 flex items-center justify-between text-[10px]"
                      style={{ color: theme.muted }}
                    >
                      <span>{h.chapterTitle}</span>
                      <button
                        className="hover:text-primary"
                        onClick={() =>
                          lib.navigate({
                            view: "reader",
                            bookId: book.id,
                            chapterId: h.chapterId,
                            highlightId: h.id,
                          })
                        }
                      >
                        定位
                      </button>
                    </div>
                  </div>
                ))
              ))}
            {tab === "qa" &&
              (panelQa.length === 0 ? (
                <PanelEmpty text="选中文字后点「问 AI」，Codex 会结合全书作答，回答记录在该文段上。" />
              ) : (
                panelQa.map(h => (
                  <button
                    key={h.id}
                    onClick={() => setAiTargetId(h.id)}
                    className="mb-3 block w-full rounded-md p-3 text-left shadow-sm"
                    style={{ background: theme.bg }}
                  >
                    <p className="font-reading text-[12.5px] leading-6 opacity-70">
                      「{h.text.slice(0, 50)}
                      {h.text.length > 50 ? "…" : ""}」
                    </p>
                    <div className="font-meta mt-2 flex items-center gap-1.5 text-[10.5px] text-primary">
                      <Sparkles size={11} /> {h.aiQa!.length} 条问答
                    </div>
                    <p className="mt-1 truncate text-[12px]">
                      {h.aiQa![h.aiQa!.length - 1].q}
                    </p>
                  </button>
                ))
              ))}

            {/* 引用本书的笔记（backlinks） */}
            {citingNotes.length > 0 && (
              <div
                className="mt-4 border-t pt-3"
                style={{ borderColor: theme.border }}
              >
                <div
                  className="font-meta mb-2 text-[10px] uppercase tracking-[0.16em]"
                  style={{ color: theme.muted }}
                >
                  引用本书的笔记 · {citingNotes.length}
                </div>
                {citingNotes.map(n => (
                  <button
                    key={n.id}
                    onClick={() => lib.navigate({ view: "note", noteId: n.id })}
                    className="mb-1.5 block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:opacity-70"
                    style={{ background: theme.bg }}
                  >
                    <Quote size={10} className="mr-1.5 inline text-primary" />
                    {n.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PanelEmpty({ text }: { text: string }) {
  return <p className="px-1 text-xs leading-6 opacity-60">{text}</p>;
}

/** 书摘卡片 */
function MarkCard({
  h,
  onLocate,
  onAskAi,
}: {
  h: Highlight;
  onLocate: () => void;
  onAskAi: () => void;
}) {
  const style = h.style ?? { kind: "underline" as const, color: "orange" };
  const c = swatch(style.color);
  return (
    <div className="mb-3 rounded-md bg-card p-3 shadow-sm">
      <div
        className="mb-1.5 inline-block h-2.5 w-6 rounded-sm"
        style={{
          background:
            style.kind === "underline"
              ? `linear-gradient(transparent 60%, ${c.solid} 60%)`
              : style.kind === "background"
                ? c.soft
                : c.solid,
        }}
      />
      <p className="font-reading text-[12.5px] leading-6">{h.text}</p>
      <div className="font-meta mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {h.chapterTitle} · {formatDate(h.createdAt)}
        </span>
      </div>
      <div className="mt-1.5 flex gap-2.5 text-[11px]">
        <button
          className="text-muted-foreground hover:text-primary"
          onClick={onLocate}
        >
          定位
        </button>
        <button
          className="flex items-center gap-0.5 text-primary hover:underline"
          onClick={onAskAi}
        >
          <Sparkles size={10} /> 问 AI
        </button>
        {h.noteId && (
          <span className="flex items-center gap-0.5 text-muted-foreground">
            <Quote size={10} /> 已引用
          </span>
        )}
      </div>
    </div>
  );
}

/** 段落：按书摘分段渲染 */
function Paragraph({
  index,
  text,
  ranges,
  recall,
  onSegmentClick,
}: {
  index: number;
  text: string;
  ranges: { h: Highlight; start: number; end: number }[];
  recall: boolean;
  onSegmentClick: (highlightId: string, top: number, left: number) => void;
}) {
  const wrapRef = useRef<HTMLParagraphElement>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const segs = segmentParagraph(text, ranges);
  const hasNote = ranges.some(r => r.h.note);

  return (
    <p ref={wrapRef} data-pi={index}>
      {segs.map((s, i) => {
        if (!s.highlight) return <span key={i}>{s.text}</span>;
        const h = s.highlight;
        const style = h.style ?? {
          kind: "underline" as const,
          color: "orange",
        };
        const c = swatch(style.color);
        const cls =
          style.kind === "underline"
            ? "hl-underline"
            : style.kind === "background"
              ? "hl-background"
              : style.kind === "color"
                ? "hl-color"
                : "";
        return (
          <span
            key={i}
            className={`hl-clickable ${cls} ${recall && !revealed.has(h.id) ? "select-none blur-[5px]" : ""}`}
            style={
              {
                "--hl-solid": recall ? "transparent" : c.solid,
                "--hl-soft": recall ? "transparent" : c.soft,
              } as React.CSSProperties
            }
            title={recall && !revealed.has(h.id) ? "点击揭示摘录" : undefined}
            onClick={e => {
              if (recall) {
                setRevealed(current => new Set(current).add(h.id));
                return;
              }
              const wrap = wrapRef.current?.closest(".relative");
              const wrect = wrap?.getBoundingClientRect();
              const rect = (e.target as HTMLElement).getBoundingClientRect();
              if (wrect) {
                onSegmentClick(
                  h.id,
                  rect.bottom - wrect.top + 6,
                  rect.left - wrect.left + rect.width / 2
                );
              }
            }}
          >
            {s.text}
            {(h.note || (h.aiQa?.length ?? 0) > 0) && style.kind === "none" && (
              <Sparkles
                size={11}
                className="mb-0.5 ml-0.5 inline text-primary"
              />
            )}
          </span>
        );
      })}
      {hasNote && (
        <MessageSquarePlus
          size={13}
          className="mb-0.5 ml-1 inline text-primary"
        />
      )}
    </p>
  );
}

/** 点击已有书摘的弹层：查看/编辑批注（可命名）、标签、挖空、加入复习、引用（三级浏览器）、问 AI、删除 */
function HighlightPopup({
  h,
  top,
  left,
  notes,
  books,
  currentBookId,
  onEditNote,
  onEditName,
  onEditTags,
  onEditCloze,
  onToggleReview,
  onAddToMindMap,
  onAddToOutline,
  onCitePassage,
  onAskAi,
  onDelete,
  onClose,
}: {
  h: Highlight;
  top: number;
  left: number;
  notes: import("@/types").Note[];
  books: Book[];
  currentBookId: string;
  onEditNote: (text: string) => void;
  onEditName: (name: string) => void;
  onEditTags: (tags: string[]) => void;
  onEditCloze: (cloze: string[]) => void;
  onToggleReview: () => void;
  onAddToMindMap: () => void;
  onAddToOutline: () => void;
  onCitePassage: (t: CitationTarget, noteId: string | "new") => void;
  onAskAi: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [citing, setCiting] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [draft, setDraft] = useState(h.note ?? "");
  const [nameDraft, setNameDraft] = useState(h.name ?? "");
  const [tagDraft, setTagDraft] = useState("");
  const [clozeDraft, setClozeDraft] = useState("");
  const tags = h.tags ?? [];
  const cloze = h.cloze ?? [];
  const inReview = !!h.review;

  const addTag = () => {
    const t = tagDraft.trim();
    if (!t) return;
    if (!tags.includes(t)) onEditTags([...tags, t]);
    setTagDraft("");
  };

  const addCloze = () => {
    const c = clozeDraft.trim();
    if (!c) return;
    if (!cloze.includes(c)) onEditCloze([...cloze, c]);
    setClozeDraft("");
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="float-pop absolute z-40 w-[300px] -translate-x-1/2 rounded-lg border border-border bg-popover p-3"
      style={{ top, left }}
    >
      {h.name && (
        <div className="font-meta mb-1 flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-primary">
          <MessageSquarePlus size={10} /> {h.name}
        </div>
      )}
      <p className="font-reading max-h-20 overflow-hidden text-[12px] leading-5 text-muted-foreground">
        「{h.text}」
      </p>

      {/* 标签与挖空展示 */}
      {(tags.length > 0 || cloze.length > 0 || inReview) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {inReview && (
            <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
              复习中
            </span>
          )}
          {tags.map(t => (
            <span
              key={t}
              className="flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-px text-[10px] text-muted-foreground"
            >
              <Tag size={8} />
              {t}
              <button
                className="opacity-50 hover:opacity-100"
                onClick={() => onEditTags(tags.filter(x => x !== t))}
                aria-label={`移除标签 ${t}`}
              >
                <X size={8} />
              </button>
            </span>
          ))}
          {cloze.map(c => (
            <span
              key={c}
              className="flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-px text-[10px] text-foreground"
            >
              挖空 {c.length > 6 ? c.slice(0, 6) + "…" : c}
              <button
                className="opacity-50 hover:opacity-100"
                onClick={() => onEditCloze(cloze.filter(x => x !== c))}
                aria-label={`移除挖空 ${c}`}
              >
                <X size={8} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 标签 / 挖空编辑区 */}
      {tagging && (
        <div className="mt-2 space-y-1.5 rounded-md bg-secondary/50 p-2">
          <div className="flex gap-1.5">
            <input
              value={tagDraft}
              onChange={e => setTagDraft(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addTag()}
              placeholder="新标签，回车添加"
              className="h-6 flex-1 rounded border border-border bg-card px-1.5 text-[11px] outline-none focus:border-primary/60"
            />
            <button
              onClick={addTag}
              className="rounded bg-primary px-2 text-[10.5px] text-primary-foreground"
            >
              标签
            </button>
          </div>
          <div className="flex gap-1.5">
            <input
              value={clozeDraft}
              onChange={e => setClozeDraft(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addCloze()}
              placeholder="挖空词（须为原文片段），回车添加"
              className="h-6 flex-1 rounded border border-border bg-card px-1.5 text-[11px] outline-none focus:border-primary/60"
            />
            <button
              onClick={addCloze}
              className="rounded bg-primary px-2 text-[10.5px] text-primary-foreground"
            >
              挖空
            </button>
          </div>
        </div>
      )}

      {h.note && !editing && (
        <p className="mt-2 rounded-md bg-accent/40 p-2 text-[12.5px] leading-6">
          {h.note}
        </p>
      )}
      {editing && (
        <div className="mt-2">
          <input
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            placeholder="批注名称（可选）"
            className="mb-1.5 h-7 w-full rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-primary/60"
          />
          <textarea
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="h-16 w-full resize-none rounded-md border border-border bg-card p-2 text-[12.5px] leading-5 outline-none focus:border-primary/60"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button
              onClick={() => setEditing(false)}
              className="px-2 py-0.5 text-[11.5px] text-muted-foreground"
            >
              取消
            </button>
            <button
              onClick={() => {
                onEditNote(draft.trim());
                onEditName(nameDraft.trim());
                setEditing(false);
              }}
              className="rounded-full bg-primary px-2.5 py-0.5 text-[11.5px] text-primary-foreground"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {(h.aiQa?.length ?? 0) > 0 && (
        <div className="font-meta mt-2 flex items-center gap-1 text-[10.5px] text-primary">
          <Sparkles size={10} /> {h.aiQa!.length} 条 AI 问答记录
        </div>
      )}

      {citing ? (
        <div className="relative mt-2 border-t border-border pt-1.5">
          <div className="relative" style={{ height: 320 }}>
            <div className="absolute inset-0">
              <CiteBrowser
                books={books}
                currentBookId={currentBookId}
                notes={notes}
                onSelect={onCitePassage}
                onClose={() => setCiting(false)}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap border-t border-border pt-2 text-[12px]">
          <button
            onClick={() => setEditing(true)}
            className="flex flex-1 items-center justify-center gap-1 rounded py-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <MessageSquarePlus size={12} /> {h.note ? "改批注" : "批注"}
          </button>
          <button
            onClick={() => setTagging(v => !v)}
            className={`flex flex-1 items-center justify-center gap-1 rounded py-1 hover:bg-secondary ${
              tagging
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Tag size={12} /> 标签
          </button>
          <button
            onClick={onToggleReview}
            className={`flex flex-1 items-center justify-center gap-1 rounded py-1 hover:bg-secondary ${
              inReview
                ? "font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {inReview ? "移出复习" : "加入复习"}
          </button>
          <button
            onClick={onAddToMindMap}
            className="flex flex-1 items-center justify-center gap-1 rounded py-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <GitBranch size={12} /> 脑图
          </button>
          <button
            onClick={onAddToOutline}
            className="flex flex-1 items-center justify-center gap-1 rounded py-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <ListPlus size={12} /> 目录
          </button>
          <button
            onClick={() => setCiting(true)}
            className="flex flex-1 items-center justify-center gap-1 rounded py-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Quote size={12} /> 引用
          </button>
          <button
            onClick={onAskAi}
            className="flex flex-1 items-center justify-center gap-1 rounded py-1 font-medium text-primary hover:bg-accent/40"
          >
            <Sparkles size={12} /> 问 AI
          </button>
          <button
            onClick={onDelete}
            className="flex flex-1 items-center justify-center gap-1 rounded py-1 text-muted-foreground hover:text-destructive"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
