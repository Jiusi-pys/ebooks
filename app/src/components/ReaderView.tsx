import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Languages,
  List,
  ListPlus,
  MessageSquarePlus,
  Minimize2,
  PanelRightDashed,
  PanelRightOpen,
  Pin,
  Quote,
  RefreshCw,
  Sparkles,
  Tag,
  Trash2,
  Eye,
  PenLine,
  GitBranch,
  Link2,
  Unlink,
  X,
} from "lucide-react";
import { newReviewState } from "@/lib/srs";
import type { Library } from "@/hooks/useLibrary";
import type {
  Book,
  CitationAnchor,
  Highlight,
  HighlightStyle,
  Note,
  OutlineItem,
  PassageAnchor,
  TextPassageAnchor,
  TypeSettings,
} from "@/types";
import {
  fontStack,
  horizontalReaderPageState,
  loadTypeSettings,
  locateHighlight,
  planReaderChapterEntry,
  readerPagePadding,
  readerScrollOffset,
  readerScrollRatio,
  saveTypeSettings,
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
import { PdfSelectionToolbar } from "./reader/PdfSelectionToolbar";
import { BilingualReader } from "./reader/BilingualReader";
import { inferTargetLanguage, type BilingualLanguage } from "@/lib/bilingual";
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
import {
  resolvePdfReaderMode,
  resolveReaderChapter,
  supportsPdfReflow,
} from "@/lib/pdfReaderState";
import { OutlinePanel } from "./reader/OutlinePanel";
import { appendCitationBlock, citationLevelOf } from "@/lib/citations";
import { CitationNotePicker } from "./reader/CitationNotePicker";
import {
  isRecallHighlightConcealed,
  revealRecallHighlight,
} from "@/lib/recall";
import { ExpandableSelectionAction } from "./reader/ExpandableSelectionAction";
import { AssociationPicker } from "./reader/AssociationPicker";
import { AssociationPopup } from "./reader/AssociationPopup";
import {
  passageAnchorFromHighlight,
  passageAnchorKey,
} from "@/lib/associations";
import {
  loadReaderPanelMode,
  parseReaderPanelMode,
  readerPanelIsVisible,
  readerPanelOccupiesLayout,
  READER_PANEL_MODE_STORAGE_KEY,
  saveReaderPanelMode,
  toggleReaderPanelMode,
  type ReaderPanelMode,
} from "@/lib/readerPanelMode";

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

interface AssociationPopupState {
  anchor: PassageAnchor;
  top: number;
  left: number;
}

interface AssociationRange {
  anchor: TextPassageAnchor;
  associationIds: string[];
  start: number;
  end: number;
}

type PanelTab = "marks" | "notes" | "qa";
type ReadingPosture = "read" | "immersive" | "recall";

export function ReaderView({
  lib,
  book,
  onImmersiveChange,
}: {
  lib: Library;
  book: Book;
  onImmersiveChange?: (active: boolean) => void;
}) {
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
  const [pdfCitationPopup, setPdfCitationPopup] = useState<HlPopup | null>(
    null
  );
  const [pdfAnchor, setPdfAnchor] = useState<string | null>(null);
  const [pdfAnchorPage, setPdfAnchorPage] = useState<number | null>(null);
  const [bilingualLanguage, setBilingualLanguage] =
    useState<BilingualLanguage | null>(null);
  const [splitLayout, setSplitLayout] = useState<ReaderPane>(MAIN_READER_PANE);
  const [posture, setPosture] = useState<ReadingPosture>("read");
  const [associationSource, setAssociationSource] =
    useState<PassageAnchor | null>(null);
  const [associationPopup, setAssociationPopup] =
    useState<AssociationPopupState | null>(null);
  const [readerPanelMode, setReaderPanelMode] =
    useState<ReaderPanelMode>(loadReaderPanelMode);
  const [readerPanelTransientOpen, setReaderPanelTransientOpen] =
    useState(false);
  const [wideReaderPanel, setWideReaderPanel] = useState(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(min-width: 1280px)").matches
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const activeChapterRef = useRef<string | null>(null);
  const readerPanelCloseTimerRef = useRef<number | null>(null);
  const previousPageTurnModeRef = useRef(type.pageTurnMode);
  const modeSwitchRatioRef = useRef<number | null>(null);
  const chapterEntryRatioRef = useRef<number | null>(null);
  const lastWheelTurnRef = useRef(0);
  const [horizontalPage, setHorizontalPage] = useState({
    page: 1,
    pageCount: 1,
    atStart: true,
    atEnd: true,
  });

  const theme = themeById(type.themeId);
  /** 原版 PDF 版面模式（保留排版逐页阅读） */
  const isOriginal =
    book.format === "pdf" && resolvePdfReaderMode(book) === "original";
  const chapterId =
    lib.route.chapterId || book.progress.chapterId || book.chapters[0]?.id;
  const { chapter, chapterIndex: chapterIdx } = resolveReaderChapter(
    book,
    chapterId
  );

  const bookHighlights = useMemo(
    () => lib.highlights.filter(h => h.bookId === book.id),
    [lib.highlights, book.id]
  );
  const contentHighlights = useMemo(
    () => bookHighlights.filter(h => citationLevelOf(h) === "content"),
    [bookHighlights]
  );

  const associationEndpoints = useMemo(() => {
    const grouped = new Map<
      string,
      { anchor: PassageAnchor; associationIds: string[] }
    >();
    if (!chapter) return grouped;
    for (const association of lib.associations) {
      for (const anchor of [association.source, association.target]) {
        if (anchor.bookId !== book.id || anchor.chapterId !== chapter.id)
          continue;
        const key = passageAnchorKey(anchor);
        const existing = grouped.get(key);
        if (existing) existing.associationIds.push(association.id);
        else grouped.set(key, { anchor, associationIds: [association.id] });
      }
    }
    return grouped;
  }, [book.id, chapter, lib.associations]);

  const associationRangesByPara = useMemo(() => {
    const grouped = new Map<number, AssociationRange[]>();
    if (!chapter) return grouped;
    for (const { anchor, associationIds } of associationEndpoints.values()) {
      if (anchor.kind !== "text") continue;
      const paragraph = chapter.paragraphs[anchor.paraIndex];
      if (paragraph === undefined) continue;
      let start = anchor.start;
      let end = anchor.end;
      if (paragraph.slice(start, end) !== anchor.text) {
        const fallback = paragraph.indexOf(anchor.text);
        if (fallback < 0) continue;
        start = fallback;
        end = fallback + anchor.text.length;
      }
      const ranges = grouped.get(anchor.paraIndex) ?? [];
      ranges.push({ anchor, associationIds, start, end });
      grouped.set(anchor.paraIndex, ranges);
    }
    return grouped;
  }, [associationEndpoints, chapter]);

  const pdfAssociationDecorations = useMemo(
    () =>
      Array.from(associationEndpoints.entries()).flatMap(
        ([key, { anchor, associationIds }]) =>
          anchor.kind === "pdf"
            ? [
                {
                  key,
                  anchor: anchor.pdfAnchor,
                  count: associationIds.length,
                },
              ]
            : []
      ),
    [associationEndpoints]
  );

  /** 当前章节书摘 → 按段落归组定位 */
  const rangesByPara = useMemo(() => {
    const map = new Map<
      number,
      { h: Highlight; start: number; end: number }[]
    >();
    if (!chapter) return map;
    for (const h of lib.highlights) {
      if (citationLevelOf(h) !== "content") continue;
      if (h.bookId !== book.id) continue;
      if (h.chapterId !== chapter.id) continue;
      const loc = locateHighlight(chapter, h);
      if (!loc) continue;
      const arr = map.get(loc.paraIndex) ?? [];
      arr.push({ h, start: loc.start, end: loc.end });
      map.set(loc.paraIndex, arr);
    }
    return map;
  }, [lib.highlights, book.id, chapter]);

  const aiTarget = aiTargetId
    ? (lib.highlights.find(h => h.id === aiTargetId) ?? null)
    : null;
  const activeStudySet = lib.route.studySetId
    ? lib.studySets.find(set => set.id === lib.route.studySetId)
    : undefined;
  const splitBooks = getSplitBooks(lib.books, book, activeStudySet);

  const cancelReaderPanelClose = useCallback(() => {
    if (readerPanelCloseTimerRef.current !== null) {
      window.clearTimeout(readerPanelCloseTimerRef.current);
      readerPanelCloseTimerRef.current = null;
    }
  }, []);

  const openReaderPanel = useCallback(() => {
    cancelReaderPanelClose();
    setReaderPanelTransientOpen(true);
  }, [cancelReaderPanelClose]);

  const closeReaderPanel = useCallback(() => {
    cancelReaderPanelClose();
    setReaderPanelTransientOpen(false);
  }, [cancelReaderPanelClose]);

  const scheduleReaderPanelClose = useCallback(() => {
    cancelReaderPanelClose();
    readerPanelCloseTimerRef.current = window.setTimeout(() => {
      setReaderPanelTransientOpen(false);
      readerPanelCloseTimerRef.current = null;
    }, 240);
  }, [cancelReaderPanelClose]);

  const changeReaderPanelMode = useCallback(
    (mode: ReaderPanelMode) => {
      cancelReaderPanelClose();
      setReaderPanelMode(mode);
      saveReaderPanelMode(mode);
      // Keep an overlay visible across mode changes; narrow pinned panels stay
      // open until the user explicitly closes them.
      setReaderPanelTransientOpen(mode === "auto" || !wideReaderPanel);
    },
    [cancelReaderPanelClose, wideReaderPanel]
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const sync = () => setWideReaderPanel(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== READER_PANEL_MODE_STORAGE_KEY) return;
      setReaderPanelMode(parseReaderPanelMode(event.newValue));
      setReaderPanelTransientOpen(false);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !readerPanelOccupiesLayout(readerPanelMode, wideReaderPanel)
      ) {
        closeReaderPanel();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeReaderPanel, readerPanelMode, wideReaderPanel]);

  useEffect(() => {
    if (aiTarget) openReaderPanel();
  }, [aiTarget, openReaderPanel]);

  useEffect(() => () => cancelReaderPanelClose(), [cancelReaderPanelClose]);

  useEffect(() => {
    const active = posture === "immersive";
    onImmersiveChange?.(active);
    return () => {
      if (active) onImmersiveChange?.(false);
    };
  }, [onImmersiveChange, posture]);

  useEffect(() => {
    if (posture !== "immersive") return;
    const exitImmersive = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPosture("read");
    };
    window.addEventListener("keydown", exitImmersive);
    return () => window.removeEventListener("keydown", exitImmersive);
  }, [posture]);

  useEffect(() => saveTypeSettings(type), [type]);

  const updateTypeSettings = useCallback(
    (next: TypeSettings) => {
      if (next.pageTurnMode !== type.pageTurnMode && scrollRef.current) {
        modeSwitchRatioRef.current = readerScrollRatio(
          scrollRef.current,
          type.pageTurnMode
        );
      }
      setType(next);
    },
    [type.pageTurnMode]
  );

  // 首次打开恢复章内进度；只有明确切章时才回到顶部并记录重置。
  useEffect(() => {
    if (!chapter) return;
    const plan = planReaderChapterEntry(
      activeChapterRef.current,
      chapter.id,
      book.progress,
      activeChapterRef.current === null && Boolean(lib.route.chapterId)
    );
    const entryRatio = chapterEntryRatioRef.current ?? plan.ratio;
    chapterEntryRatioRef.current = null;
    activeChapterRef.current = chapter.id;
    setSel(null);
    setHlPopup(null);
    setPdfCitationPopup(null);
    let secondFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const container = scrollRef.current;
        if (!container) return;
        const offset = readerScrollOffset(
          container,
          type.pageTurnMode,
          entryRatio
        );
        container.scrollTo(
          type.pageTurnMode === "horizontal"
            ? { left: offset, top: 0 }
            : { left: 0, top: offset }
        );
        if (type.pageTurnMode === "horizontal")
          setHorizontalPage(horizontalReaderPageState(container));
      });
    });
    if (plan.persist || entryRatio !== plan.ratio)
      void lib.saveProgress(book.id, chapter.id, entryRatio);
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id]);

  // Preserve the current semantic chapter position when changing scroll axis.
  useEffect(() => {
    if (previousPageTurnModeRef.current === type.pageTurnMode) return;
    previousPageTurnModeRef.current = type.pageTurnMode;
    const ratio = modeSwitchRatioRef.current ?? book.progress.ratio;
    modeSwitchRatioRef.current = null;
    let secondFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const container = scrollRef.current;
        if (!container) return;
        const offset = readerScrollOffset(container, type.pageTurnMode, ratio);
        container.scrollTo(
          type.pageTurnMode === "horizontal"
            ? { left: offset, top: 0 }
            : { left: 0, top: offset }
        );
        if (type.pageTurnMode === "horizontal")
          setHorizontalPage(horizontalReaderPageState(container));
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [book.progress.ratio, type.pageTurnMode]);

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

  // 关联跳转：优先使用独立文段锚点，不要求目标先成为书摘。
  useEffect(() => {
    const anchor = lib.route.passageAnchor;
    if (
      !anchor ||
      anchor.kind !== "text" ||
      anchor.bookId !== book.id ||
      anchor.chapterId !== chapter?.id
    )
      return;
    const key = passageAnchorKey(anchor);
    requestAnimationFrame(() => {
      const elements = wrapRef.current?.querySelectorAll<HTMLElement>(
        "[data-association-anchor-keys]"
      );
      const targets = Array.from(elements ?? []).filter(element => {
        try {
          const keys = JSON.parse(
            element.dataset.associationAnchorKeys ?? "[]"
          ) as unknown;
          return Array.isArray(keys) && keys.includes(key);
        } catch {
          return false;
        }
      });
      const fallback = wrapRef.current?.querySelector<HTMLElement>(
        `[data-pi="${anchor.paraIndex}"]`
      );
      const element = targets[0] ?? fallback;
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
      const flashTargets =
        targets.length > 0 ? targets : element ? [element] : [];
      for (const target of flashTargets) target.classList.add("anchor-flash");
      window.setTimeout(() => {
        for (const target of flashTargets)
          target.classList.remove("anchor-flash");
      }, 2400);
    });
  }, [book.id, chapter?.id, lib.route.passageAnchor]);

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
    const associationAnchor = lib.route.passageAnchor;
    if (
      associationAnchor?.kind === "pdf" &&
      associationAnchor.bookId === book.id
    ) {
      setPdfAnchor(associationAnchor.text);
      setPdfAnchorPage(associationAnchor.pdfAnchor.page);
      return;
    }
    const hid = lib.route.highlightId;
    if (!hid) return;
    const h = lib.highlights.find(x => x.id === hid);
    if (h) {
      setPdfAnchor(h.text);
      setPdfAnchorPage(h.pdfAnchor?.page ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, lib.route.highlightId, lib.route.passageAnchor, isOriginal]);

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
        pdfAnchor: { page: info.page, rects: info.rects },
        ...extra,
      });
      emitEvent("highlight.created", {
        extId: h.id,
        bookExtId: book.id,
        bookTitle: book.title,
        chapterId: chapter.id,
        chapterTitle,
        text: h.text,
        paraIndex: h.paraIndex,
        start: h.start,
        end: h.end,
        pdfAnchor: h.pdfAnchor,
        styleKind: h.style?.kind ?? "underline",
        styleColor: h.style?.color ?? "orange",
        note: h.note,
      });
      window.getSelection()?.removeAllRanges();
      setPdfSel(null);
      return h;
    },
    [chapter, book.id, book.title, lib]
  );

  const saveTimer = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    const current = scrollRef.current;
    if (current && type.pageTurnMode === "horizontal") {
      const next = horizontalReaderPageState(current);
      setHorizontalPage(previous =>
        previous.page === next.page &&
        previous.pageCount === next.pageCount &&
        previous.atStart === next.atStart &&
        previous.atEnd === next.atEnd
          ? previous
          : next
      );
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const el = scrollRef.current;
      if (!el || !chapter) return;
      lib.saveProgress(
        book.id,
        chapter.id,
        readerScrollRatio(el, type.pageTurnMode)
      );
    }, 400);
  }, [book.id, chapter, lib, type.pageTurnMode]);

  const navigateToChapter = useCallback(
    (index: number, entryRatio?: number) => {
      const target = book.chapters[index];
      if (!target) return false;
      if (entryRatio !== undefined) chapterEntryRatioRef.current = entryRatio;
      lib.navigate({
        view: "reader",
        bookId: book.id,
        chapterId: target.id,
        studySetId: activeStudySet?.id,
      });
      return true;
    },
    [activeStudySet?.id, book.chapters, book.id, lib]
  );

  const turnHorizontalPage = useCallback(
    (direction: -1 | 1) => {
      const container = scrollRef.current;
      if (!container) return;
      const state = horizontalReaderPageState(container);
      if (direction < 0 && state.atStart) {
        navigateToChapter(chapterIdx - 1, 1);
        return;
      }
      if (direction > 0 && state.atEnd) {
        navigateToChapter(chapterIdx + 1, 0);
        return;
      }
      const maximum = Math.max(
        0,
        container.scrollWidth - container.clientWidth
      );
      const targetPage = Math.max(0, state.page - 1 + direction);
      container.scrollTo({
        left: Math.min(maximum, targetPage * container.clientWidth),
        behavior: "smooth",
      });
    },
    [chapterIdx, navigateToChapter]
  );

  const onHorizontalWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (
        Math.abs(event.deltaY) < 12 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      )
        return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastWheelTurnRef.current < 420) return;
      lastWheelTurnRef.current = now;
      turnHorizontalPage(event.deltaY < 0 ? -1 : 1);
    },
    [turnHorizontalPage]
  );

  const onVerticalWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const container = scrollRef.current;
      if (!container || Math.abs(event.deltaY) < 12) return;
      const maximum = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      );
      const atStart = container.scrollTop <= 2;
      const atEnd = maximum - container.scrollTop <= 2;
      if (!((event.deltaY < 0 && atStart) || (event.deltaY > 0 && atEnd)))
        return;
      const now = Date.now();
      if (now - lastWheelTurnRef.current < 420) return;
      lastWheelTurnRef.current = now;
      if (event.deltaY < 0) navigateToChapter(chapterIdx - 1, 1);
      else navigateToChapter(chapterIdx + 1, 0);
    },
    [chapterIdx, navigateToChapter]
  );

  useEffect(() => {
    if (type.pageTurnMode !== "horizontal" || isOriginal || bilingualLanguage)
      return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        turnHorizontalPage(-1);
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        turnHorizontalPage(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bilingualLanguage, isOriginal, turnHorizontalPage, type.pageTurnMode]);

  useEffect(() => {
    if (type.pageTurnMode !== "horizontal" || isOriginal) return;
    const container = scrollRef.current;
    if (!container) return;
    let frame = requestAnimationFrame(() => {
      setHorizontalPage(horizontalReaderPageState(container));
    });
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setHorizontalPage(horizontalReaderPageState(container));
      });
    });
    observer.observe(container);
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [
    chapter?.id,
    isOriginal,
    type.columns,
    type.fontId,
    type.fontSize,
    type.fontWeight,
    type.letterSpacing,
    type.lineHeight,
    type.pageMargin,
    type.pageTurnMode,
  ]);

  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (pdfSaveTimer.current) window.clearTimeout(pdfSaveTimer.current);
    },
    [chapter?.id, type.pageTurnMode]
  );

  const onBilingualProgress = useCallback(
    (progressChapterId: string, ratio: number) =>
      lib.saveProgress(book.id, progressChapterId, ratio),
    [book.id, lib]
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1800);
  }, []);

  const beginAssociation = useCallback((source: PassageAnchor) => {
    setAssociationPopup(null);
    setHlPopup(null);
    setPdfCitationPopup(null);
    setSel(null);
    setPdfSel(null);
    window.getSelection()?.removeAllRanges();
    setAssociationSource(source);
  }, []);

  const beginSelectionAssociation = useCallback(() => {
    if (!sel || !chapter) return;
    beginAssociation({
      kind: "text",
      bookId: book.id,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      text: sel.text,
      paraIndex: sel.paraIndex,
      start: sel.start,
      end: sel.end,
    });
  }, [beginAssociation, book.id, chapter, sel]);

  const beginPdfAssociation = useCallback(() => {
    if (!pdfSel || !chapter) return;
    beginAssociation({
      kind: "pdf",
      bookId: book.id,
      chapterId: chapter.id,
      chapterTitle: `${chapter.title} · 第 ${pdfSel.page} 页`,
      text: pdfSel.text,
      pdfAnchor: { page: pdfSel.page, rects: pdfSel.rects },
    });
  }, [beginAssociation, book.id, chapter, pdfSel]);

  const beginHighlightAssociation = useCallback(
    (highlight: Highlight) => {
      const anchor = passageAnchorFromHighlight(highlight);
      if (!anchor) {
        showToast("这条旧书摘缺少精确位置，请重新选择原文后关联");
        return;
      }
      beginAssociation(anchor);
    },
    [beginAssociation, showToast]
  );

  const saveAssociation = useCallback(
    async (
      target: PassageAnchor,
      direction: import("@/types").AssociationDirection,
      label: string
    ) => {
      if (!associationSource) return;
      await lib.addAssociation(associationSource, target, {
        direction,
        label,
      });
      setAssociationSource(null);
      showToast(
        direction === "bidirectional" ? "双向关联已建立" : "单向关联已建立"
      );
    },
    [associationSource, lib, showToast]
  );

  const navigateAssociation = useCallback(
    async (anchor: PassageAnchor) => {
      setAssociationPopup(null);
      setAssociationSource(null);
      const targetBook = lib.books.find(item => item.id === anchor.bookId);
      if (targetBook?.format === "pdf") {
        const readerMode = anchor.kind === "pdf" ? "original" : "reflow";
        const switched = await lib.setReaderMode(anchor.bookId, readerMode);
        if (!switched) showToast("未找到 PDF 原始文件，可能无法精确定位");
      }
      lib.navigate({
        view: "reader",
        bookId: anchor.bookId,
        chapterId: anchor.chapterId,
        passageAnchor: anchor,
      });
    },
    [lib, showToast]
  );

  const openAssociationPopup = useCallback(
    (anchor: PassageAnchor, top: number, left: number) => {
      setHlPopup(null);
      setAssociationPopup({
        anchor,
        top: Math.max(8, Math.min(window.innerHeight - 390, top)),
        left: Math.max(180, Math.min(window.innerWidth - 180, left)),
      });
    },
    []
  );

  const addPdfMark = useCallback(
    async (style: HighlightStyle) => {
      if (!pdfSel) return;
      const saved = await createFromPdf(pdfSel, { style });
      if (saved) showToast("PDF 划线已保存");
    },
    [createFromPdf, pdfSel, showToast]
  );

  const addPdfComment = useCallback(
    async (note: string, name: string) => {
      if (!pdfSel) return;
      const saved = await createFromPdf(pdfSel, {
        style: { kind: "background", color: "yellow" },
        note,
        ...(name ? { name } : {}),
      });
      if (saved) {
        setTab("notes");
        showToast("PDF 批注已保存");
      }
    },
    [createFromPdf, pdfSel, showToast]
  );

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
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        text: h.text,
        paraIndex: h.paraIndex,
        start: h.start,
        end: h.end,
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
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        text: h.text,
        paraIndex: h.paraIndex,
        start: h.start,
        end: h.end,
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

  /** 把指定原文锚点建立为结构化引用，并同步笔记与图谱关系。 */
  const citePassage = useCallback(
    async (
      t: CitationTarget,
      noteId: string | "new",
      existing?: Highlight
    ): Promise<Highlight> => {
      let note: Note;
      let createdNote = false;
      const level = t.level;
      const chapterId = t.chapterId ?? "";
      const chapterTitle = t.chapterTitle ?? "整本书";
      const sourceText =
        t.text ?? (level === "chapter" ? chapterTitle : t.bookTitle);
      const citation: CitationAnchor =
        level === "book"
          ? { level }
          : level === "chapter"
            ? { level, chapterId }
            : {
                level,
                chapterId,
                paraIndex: t.paraIndex,
                start: t.start ?? 0,
                end: t.end ?? sourceText.length,
                pdfAnchor: t.pdfAnchor,
              };
      if (noteId === "new") {
        const title =
          level === "book"
            ? `《${t.bookTitle}》引用`
            : level === "chapter"
              ? `《${t.bookTitle}》· ${chapterTitle}`
              : `《${t.bookTitle}》书摘`;
        note = await lib.createNote(title);
        createdNote = true;
      } else {
        const existingNote = lib.notes.find(item => item.id === noteId);
        if (!existingNote) throw new Error("目标笔记不存在，请重新选择");
        note = existingNote;
      }

      if (existing?.noteId && existing.noteId !== note.id) {
        await lib.unlinkCitation(existing.id);
      }

      let h: Highlight;
      if (existing) {
        h = {
          ...existing,
          noteId: note.id,
          citation,
        };
        await lib.updateHighlight(h);
      } else {
        const duplicate = lib.highlights.find(
          item =>
            item.bookId === t.bookId &&
            citationLevelOf(item) === level &&
            item.chapterId === chapterId &&
            item.paraIndex === t.paraIndex &&
            item.text === sourceText &&
            item.noteId === note.id
        );
        if (duplicate) {
          h = { ...duplicate, citation };
          await lib.updateHighlight(h);
        } else {
          h = await lib.addHighlight({
            bookId: t.bookId,
            chapterId,
            chapterTitle,
            text: sourceText,
            paraIndex: t.paraIndex,
            start: level === "content" ? (t.start ?? 0) : undefined,
            end: level === "content" ? (t.end ?? sourceText.length) : undefined,
            pdfAnchor: t.pdfAnchor,
            // Citation-only anchors are visible through the dedicated citation
            // decoration and disappear completely when the relation is removed.
            style: { kind: "none", color: "orange" },
            noteId: note.id,
            citation,
          });
          emitEvent("highlight.created", {
            extId: h.id,
            bookExtId: t.bookId,
            bookTitle: t.bookTitle,
            chapterId,
            chapterTitle,
            text: h.text,
            citationLevel: level,
            paraIndex: h.paraIndex,
            start: h.start,
            end: h.end,
            pdfAnchor: h.pdfAnchor,
            styleKind: "none",
            styleColor: "orange",
            noteExtId: note.id,
          });
        }
      }

      const content = appendCitationBlock(note.content, {
        level,
        highlightId: h.id,
        bookTitle: t.bookTitle,
        chapterTitle,
        text: sourceText,
      });
      if (content !== note.content) {
        await lib.saveNote({
          ...note,
          content,
        });
      }

      emitEvent("highlight.updated", {
        extId: h.id,
        bookExtId: t.bookId,
        bookTitle: t.bookTitle,
        chapterId,
        chapterTitle,
        text: h.text,
        noteExtId: note.id,
        citationLevel: level,
        paraIndex: h.paraIndex,
        start: h.start,
        end: h.end,
        pdfAnchor: h.pdfAnchor,
      });
      showToast(
        createdNote
          ? `已引用到新笔记「${note.title}」`
          : `已引用到「${note.title}」`
      );
      setShowCite(false);
      return h;
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
    navigateToChapter(idx);
  };

  const gotoOutline = (item: OutlineItem) => {
    if (!item.chapterId) return;
    if (item.chapterId === chapter.id && item.paraIndex === undefined) {
      scrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
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
    if (target === "reflow" && !supportsPdfReflow(book.chapters)) {
      showToast("此 PDF 没有可用的完整文字层，仅支持原版版面");
      return;
    }
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

  const toggleBilingual = () => {
    if (bilingualLanguage) {
      setBilingualLanguage(null);
      return;
    }
    setPosture("read");
    setSel(null);
    setTranslationSel(null);
    setHlPopup(null);
    setShowType(false);
    setShowCite(false);
    setBilingualLanguage(inferTargetLanguage(chapter.paragraphs));
  };

  const paneCount = countReaderPanes(splitLayout);
  const visibleSplitLayout =
    posture === "read" && !aiTarget && !bilingualLanguage
      ? splitLayout
      : MAIN_READER_PANE;

  const panelMarks = contentHighlights.filter(
    h => (h.style?.kind ?? "underline") !== "none" || !!h.noteId
  );
  const panelNotes = contentHighlights.filter(h => h.note);
  const panelQa = contentHighlights.filter(h => (h.aiQa?.length ?? 0) > 0);
  const readerPanelAvailable = posture === "read" || Boolean(aiTarget);
  const readerPanelPinned = readerPanelOccupiesLayout(
    readerPanelMode,
    wideReaderPanel
  );
  const readerPanelVisible = readerPanelIsVisible(
    readerPanelAvailable,
    readerPanelMode,
    readerPanelTransientOpen
  );
  const popupHl = hlPopup
    ? (lib.highlights.find(h => h.id === hlPopup.id) ?? null)
    : null;
  const popupAnchor = popupHl ? passageAnchorFromHighlight(popupHl) : null;
  const popupAssociationCount = popupAnchor
    ? (associationEndpoints.get(passageAnchorKey(popupAnchor))?.associationIds
        .length ?? 0)
    : 0;
  const pdfCitationHighlight = pdfCitationPopup
    ? (lib.highlights.find(h => h.id === pdfCitationPopup.id) ?? null)
    : null;

  return (
    <div
      data-reader-posture={posture}
      className="reader-shell relative flex h-full overflow-hidden"
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
          showMainSplitControls={!showCite && !showType && !bilingualLanguage}
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
                className={`h-12 shrink-0 items-center gap-2 border-b px-4 ${
                  posture === "immersive" ? "hidden" : "flex"
                }`}
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
                {book.format !== "pdf" && (
                  <button
                    type="button"
                    aria-pressed={!!bilingualLanguage}
                    onClick={toggleBilingual}
                    className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                      bilingualLanguage
                        ? "border-primary bg-primary text-primary-foreground"
                        : ""
                    }`}
                    style={
                      bilingualLanguage
                        ? undefined
                        : { borderColor: theme.border, color: theme.muted }
                    }
                    title="原文与译文双向同步阅读"
                  >
                    <Languages size={12} />
                    {bilingualLanguage
                      ? `双语 · ${bilingualLanguage === "中文" ? "中" : "EN"}`
                      : "双语"}
                  </button>
                )}
                <div
                  className="flex overflow-hidden rounded-full border"
                  style={{ borderColor: theme.border }}
                >
                  {(
                    [
                      ["read", "阅读", BookOpenText],
                      ["immersive", "沉浸", PenLine],
                      ["recall", "回忆", Eye],
                    ] as const
                  ).map(([mode, label, Icon]) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setPosture(mode);
                        if (mode !== "read") setBilingualLanguage(null);
                        if (mode === "immersive") {
                          setAiTargetId(null);
                          closeReaderPanel();
                          setShowType(false);
                          setShowCite(false);
                        }
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
                          : mode === "immersive"
                            ? "隐藏左右侧栏与阅读工具栏，按 Esc 退出"
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
                        onChange={updateTypeSettings}
                        onClose={() => setShowType(false)}
                      />
                    )}
                  </div>
                )}
                {readerPanelAvailable && !readerPanelVisible && (
                  <button
                    type="button"
                    onClick={openReaderPanel}
                    className="rounded-md p-1.5 transition-opacity hover:opacity-70"
                    style={{ color: theme.muted }}
                    aria-label="打开右侧阅读面板"
                    aria-controls="reader-side-panel"
                    aria-expanded="false"
                    title="打开书摘、批注与问答"
                  >
                    <PanelRightOpen size={16} aria-hidden="true" />
                  </button>
                )}
              </div>

              {posture === "immersive" && (
                <button
                  type="button"
                  onClick={() => setPosture("read")}
                  className="absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] shadow-sm backdrop-blur transition-opacity hover:opacity-75"
                  style={{
                    borderColor: theme.border,
                    background: `${theme.panel}e6`,
                    color: theme.muted,
                  }}
                  aria-label="退出沉浸模式"
                  title="退出沉浸模式（Esc）"
                >
                  <Minimize2 size={12} aria-hidden="true" /> 退出沉浸
                </button>
              )}

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
                    onSelectionClear={() => setPdfSel(null)}
                    highlights={contentHighlights}
                    associationAnchors={pdfAssociationDecorations}
                    onAssociationClick={(key, x, y) => {
                      const endpoint = associationEndpoints.get(key);
                      if (endpoint)
                        openAssociationPopup(endpoint.anchor, y + 10, x);
                    }}
                    onHighlightClick={(highlight, x, y) => {
                      setTab(highlight.note ? "notes" : "marks");
                      if (highlight.noteId) {
                        setPdfCitationPopup({
                          id: highlight.id,
                          top: y + 10,
                          left: x,
                        });
                      } else {
                        showToast(
                          highlight.note || highlight.name || "已选中 PDF 划线"
                        );
                      }
                    }}
                    anchorPage={pdfAnchorPage}
                    anchorText={pdfAnchor}
                    onAnchorConsumed={() => {
                      setPdfAnchor(null);
                      setPdfAnchorPage(null);
                      lib.navigate({
                        view: "reader",
                        bookId: book.id,
                        chapterId: chapter.id,
                        studySetId: activeStudySet?.id,
                      });
                    }}
                  />

                  {/* 原版模式划选弹层 */}
                  {pdfSel && (
                    <PdfSelectionToolbar
                      top={pdfSel.y < 190 ? pdfSel.y + 28 : pdfSel.y - 158}
                      left={pdfSel.x}
                      onHighlight={addPdfMark}
                      onComment={addPdfComment}
                      onAssociate={beginPdfAssociation}
                      notes={lib.notes}
                      sourceText={pdfSel.text}
                      onCite={async noteId => {
                        await citePassage(
                          {
                            level: "content",
                            bookId: book.id,
                            bookTitle: book.title,
                            chapterId: chapter.id,
                            chapterTitle: `${chapter.title} · 第 ${pdfSel.page} 页`,
                            paraIndex: 0,
                            start: 0,
                            end: pdfSel.text.length,
                            text: pdfSel.text,
                            pdfAnchor: {
                              page: pdfSel.page,
                              rects: pdfSel.rects,
                            },
                          },
                          noteId
                        );
                        window.getSelection()?.removeAllRanges();
                        setPdfSel(null);
                      }}
                      onCopy={async () => {
                        await navigator.clipboard.writeText(pdfSel.text);
                        window.getSelection()?.removeAllRanges();
                        setPdfSel(null);
                        showToast("已复制");
                      }}
                      onClose={() => {
                        window.getSelection()?.removeAllRanges();
                        setPdfSel(null);
                      }}
                    />
                  )}

                  {pdfCitationHighlight && pdfCitationPopup && (
                    <div
                      role="dialog"
                      aria-label="管理 PDF 引用"
                      className="fixed z-[60] w-[280px] -translate-x-1/2 rounded-lg border border-border bg-popover p-3 shadow-xl"
                      style={{
                        left: Math.max(
                          150,
                          Math.min(
                            window.innerWidth - 150,
                            pdfCitationPopup.left
                          )
                        ),
                        top: Math.max(
                          8,
                          Math.min(
                            window.innerHeight - 150,
                            pdfCitationPopup.top
                          )
                        ),
                      }}
                    >
                      <div className="font-meta flex items-center gap-1 text-[10px] uppercase tracking-wider text-primary">
                        <Quote size={11} /> 已引用
                      </div>
                      <p className="font-reading mt-1.5 line-clamp-3 text-[12px] leading-5 text-muted-foreground">
                        「{pdfCitationHighlight.text}」
                      </p>
                      <div className="mt-2.5 flex justify-end gap-2 border-t border-border pt-2 text-[11.5px]">
                        {pdfCitationHighlight.noteId && (
                          <button
                            type="button"
                            className="rounded-md px-2 py-1 text-primary hover:bg-primary/10"
                            onClick={() => {
                              lib.navigate({
                                view: "note",
                                noteId: pdfCitationHighlight.noteId,
                              });
                              setPdfCitationPopup(null);
                            }}
                          >
                            打开笔记
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={async () => {
                            await lib.unlinkCitation(pdfCitationHighlight.id);
                            setPdfCitationPopup(null);
                            showToast("引用已删除，图谱关系已同步更新");
                          }}
                        >
                          取消引用
                        </button>
                        <button
                          type="button"
                          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary"
                          onClick={() => setPdfCitationPopup(null)}
                        >
                          关闭
                        </button>
                      </div>
                    </div>
                  )}

                  {toast && (
                    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-1.5 text-xs text-background shadow-lg">
                      {toast}
                    </div>
                  )}
                </div>
              ) : bilingualLanguage ? (
                <BilingualReader
                  book={book}
                  chapterId={chapter.id}
                  theme={theme}
                  type={type}
                  initialTargetLanguage={bilingualLanguage}
                  onTargetLanguageChange={setBilingualLanguage}
                  onNavigateChapter={nextChapterId => {
                    const index = book.chapters.findIndex(
                      item => item.id === nextChapterId
                    );
                    if (index >= 0) gotoChapter(index);
                  }}
                  onProgress={onBilingualProgress}
                  className="flex-1"
                />
              ) : (
                <>
                  <div
                    ref={scrollRef}
                    data-reader-page-mode={type.pageTurnMode}
                    className={`relative min-h-0 flex-1 ${
                      type.pageTurnMode === "horizontal"
                        ? "overflow-x-auto overflow-y-hidden overscroll-x-contain"
                        : "overflow-y-auto overflow-x-hidden"
                    }`}
                    style={
                      type.pageTurnMode === "horizontal"
                        ? { containerType: "inline-size" }
                        : undefined
                    }
                    onScroll={onScroll}
                    onWheel={
                      type.pageTurnMode === "horizontal"
                        ? onHorizontalWheel
                        : onVerticalWheel
                    }
                  >
                    <div
                      ref={wrapRef}
                      className={`relative ${
                        type.pageTurnMode === "horizontal"
                          ? "reader-horizontal-pages"
                          : "mx-auto pb-28 pt-12"
                      }`}
                      style={
                        type.pageTurnMode === "horizontal"
                          ? ({
                              "--reader-page-margin": readerPagePadding(
                                type.pageMargin
                              ),
                              columnCount: type.columns,
                            } as React.CSSProperties)
                          : {
                              maxWidth: type.columns === 2 ? 1080 : 680,
                              paddingInline: readerPagePadding(type.pageMargin),
                            }
                      }
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
                        className={`reader-body${
                          type.pageTurnMode === "vertical" && type.columns === 2
                            ? " cols-2"
                            : ""
                        }`}
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
                            key={`${chapter.id}:${i}:${posture === "recall" ? "recall" : "normal"}`}
                            index={i}
                            text={p}
                            ranges={rangesByPara.get(i) ?? []}
                            associationRanges={
                              associationRangesByPara.get(i) ?? []
                            }
                            recall={posture === "recall"}
                            onSegmentClick={(hid, top, left) =>
                              setHlPopup({ id: hid, top, left })
                            }
                            onAssociationClick={openAssociationPopup}
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
                        onAssociate={beginSelectionAssociation}
                        notes={lib.notes}
                        sourceText={sel.text}
                        onCite={async noteId => {
                          await citePassage(
                            {
                              level: "content",
                              bookId: book.id,
                              bookTitle: book.title,
                              chapterId: chapter.id,
                              chapterTitle: chapter.title,
                              paraIndex: sel.paraIndex,
                              start: sel.start,
                              end: sel.end,
                              text: sel.text,
                            },
                            noteId
                          );
                          clearSelection();
                        }}
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
                        onAddToOutline={() =>
                          void addHighlightToOutline(popupHl)
                        }
                        associationCount={popupAssociationCount}
                        onAssociate={() => beginHighlightAssociation(popupHl)}
                        onCite={async noteId => {
                          await citePassage(
                            {
                              level: "content",
                              bookId: popupHl.bookId,
                              bookTitle: book.title,
                              chapterId: popupHl.chapterId,
                              chapterTitle: popupHl.chapterTitle,
                              paraIndex: popupHl.paraIndex ?? 0,
                              start: popupHl.start,
                              end: popupHl.end,
                              text: popupHl.text,
                              pdfAnchor: popupHl.pdfAnchor,
                            },
                            noteId,
                            popupHl
                          );
                          setHlPopup(null);
                        }}
                        onUnlinkCitation={async () => {
                          await lib.unlinkCitation(popupHl.id);
                          showToast("引用已删除，图谱关系已同步更新");
                          setHlPopup(null);
                        }}
                        onAskAi={() => askAiOn(popupHl)}
                        onDelete={() => {
                          void lib.removeHighlight(popupHl.id);
                          setHlPopup(null);
                        }}
                        onClose={() => setHlPopup(null)}
                        notes={lib.notes}
                      />
                    )}

                    {toast && (
                      <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-1.5 text-xs text-background shadow-lg">
                        {toast}
                      </div>
                    )}
                  </div>

                  {type.pageTurnMode === "horizontal" && (
                    <>
                      <button
                        type="button"
                        aria-label="向左翻页"
                        title="上一页（←）"
                        disabled={horizontalPage.atStart && chapterIdx === 0}
                        onClick={() => turnHorizontalPage(-1)}
                        className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border bg-background/90 shadow-md backdrop-blur-sm transition-all hover:scale-105 disabled:pointer-events-none disabled:opacity-25"
                        style={{
                          borderColor: theme.border,
                          color: theme.muted,
                        }}
                      >
                        <ChevronLeft size={20} />
                      </button>
                      <button
                        type="button"
                        aria-label="向右翻页"
                        title="下一页（→）"
                        disabled={
                          horizontalPage.atEnd &&
                          chapterIdx >= book.chapters.length - 1
                        }
                        onClick={() => turnHorizontalPage(1)}
                        className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border bg-background/90 shadow-md backdrop-blur-sm transition-all hover:scale-105 disabled:pointer-events-none disabled:opacity-25"
                        style={{
                          borderColor: theme.border,
                          color: theme.muted,
                        }}
                      >
                        <ChevronRight size={20} />
                      </button>
                      <div
                        aria-live="polite"
                        className="font-meta pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border bg-background/85 px-2.5 py-1 text-[10px] shadow-sm backdrop-blur-sm"
                        style={{
                          borderColor: theme.border,
                          color: theme.muted,
                        }}
                      >
                        {horizontalPage.page} / {horizontalPage.pageCount}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          }
        />
      </div>

      {/* 右侧：AI 抽屉或书摘面板；固定与自动隐藏共用一个外壳。 */}
      {readerPanelAvailable && (
        <>
          {readerPanelVisible &&
            readerPanelMode === "auto" &&
            !wideReaderPanel && (
              <button
                type="button"
                aria-label="关闭右侧阅读面板"
                className="absolute inset-0 z-30 bg-foreground/15 backdrop-blur-[1px]"
                onClick={closeReaderPanel}
              />
            )}
          {!readerPanelVisible && wideReaderPanel && (
            <div
              aria-hidden="true"
              className="absolute inset-y-0 right-0 z-30 w-2"
              onPointerEnter={event => {
                if (event.pointerType === "mouse") openReaderPanel();
              }}
            />
          )}
          <aside
            id="reader-side-panel"
            aria-label="书摘、批注与问答"
            aria-hidden={!readerPanelVisible}
            inert={!readerPanelVisible}
            onPointerEnter={cancelReaderPanelClose}
            onPointerLeave={event => {
              if (
                event.pointerType === "mouse" &&
                !event.currentTarget.matches(":focus-within") &&
                readerPanelMode === "auto"
              ) {
                scheduleReaderPanelClose();
              }
            }}
            onFocusCapture={cancelReaderPanelClose}
            onBlurCapture={event => {
              if (
                readerPanelMode === "auto" &&
                !event.currentTarget.contains(event.relatedTarget) &&
                !event.currentTarget.matches(":hover")
              ) {
                scheduleReaderPanelClose();
              }
            }}
            className={`flex h-full shrink-0 flex-col border-l transition-[transform,opacity] duration-200 motion-reduce:transition-none ${
              aiTarget ? "w-[340px]" : "w-72"
            } ${
              readerPanelPinned
                ? "relative"
                : "absolute inset-y-0 right-0 z-40 max-w-[calc(100%-3rem)] shadow-2xl"
            } ${
              readerPanelVisible
                ? "translate-x-0 opacity-100"
                : "pointer-events-none translate-x-full opacity-0"
            }`}
            style={{ background: theme.panel, borderColor: theme.border }}
          >
            {aiTarget ? (
              <AiDrawer
                book={book}
                chapter={chapter}
                target={aiTarget}
                theme={theme}
                onSaveQa={onSaveQa}
                onApplyStudyCard={applyStudyCard}
                headerAction={
                  <ReaderPanelModeButton
                    mode={readerPanelMode}
                    color={theme.muted}
                    onToggle={() =>
                      changeReaderPanelMode(
                        toggleReaderPanelMode(readerPanelMode)
                      )
                    }
                  />
                }
                onClose={() => {
                  setAiTargetId(null);
                  if (readerPanelMode === "auto") closeReaderPanel();
                }}
              />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
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
                          tab === t
                            ? "2px solid #f54001"
                            : "2px solid transparent",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <ReaderPanelModeButton
                    mode={readerPanelMode}
                    color={theme.muted}
                    onToggle={() =>
                      changeReaderPanelMode(
                        toggleReaderPanelMode(readerPanelMode)
                      )
                    }
                  />
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
                          onClick={() =>
                            lib.navigate({ view: "note", noteId: n.id })
                          }
                          className="mb-1.5 block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:opacity-70"
                          style={{ background: theme.bg }}
                        >
                          <Quote
                            size={10}
                            className="mr-1.5 inline text-primary"
                          />
                          {n.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </>
      )}

      {associationPopup && (
        <AssociationPopup
          position="fixed"
          top={associationPopup.top}
          left={associationPopup.left}
          current={associationPopup.anchor}
          associations={lib.associations}
          books={lib.books}
          onNavigate={navigateAssociation}
          onDelete={async associationId => {
            await lib.removeAssociation(associationId);
            showToast("关联已删除，图谱关系已同步更新");
          }}
          onAdd={() => beginAssociation(associationPopup.anchor)}
          onClose={() => setAssociationPopup(null)}
        />
      )}

      {associationSource && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-4 backdrop-blur-[1px]"
          onMouseDown={() => setAssociationSource(null)}
        >
          <AssociationPicker
            books={lib.books}
            highlights={lib.highlights}
            source={associationSource}
            onSelect={saveAssociation}
            onClose={() => setAssociationSource(null)}
          />
        </div>
      )}
    </div>
  );
}

function ReaderPanelModeButton({
  mode,
  color,
  onToggle,
}: {
  mode: ReaderPanelMode;
  color: string;
  onToggle: () => void;
}) {
  const pinned = mode === "pinned";
  const label = pinned ? "切换右侧栏为自动隐藏" : "固定显示右侧栏";
  return (
    <button
      type="button"
      className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-foreground/5"
      style={{ color }}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      onClick={event => {
        onToggle();
        if (event.detail > 0) event.currentTarget.blur();
      }}
    >
      {pinned ? (
        <PanelRightDashed size={15} aria-hidden="true" />
      ) : (
        <Pin size={15} aria-hidden="true" />
      )}
    </button>
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

/** 段落：把书摘与独立关联端点叠加渲染，重叠时两种语义都保留。 */
export function Paragraph({
  index,
  text,
  ranges,
  associationRanges,
  recall,
  onSegmentClick,
  onAssociationClick,
}: {
  index: number;
  text: string;
  ranges: { h: Highlight; start: number; end: number }[];
  associationRanges: AssociationRange[];
  recall: boolean;
  onSegmentClick: (highlightId: string, top: number, left: number) => void;
  onAssociationClick: (
    anchor: PassageAnchor,
    top: number,
    left: number
  ) => void;
}) {
  const wrapRef = useRef<HTMLParagraphElement>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const hasNote = ranges.some(r => r.h.note);
  const segments = useMemo(() => {
    const highlightRanges = ranges.filter(
      range =>
        range.start >= 0 && range.end > range.start && range.start < text.length
    );
    const linkedRanges = associationRanges.filter(
      range =>
        range.start >= 0 && range.end > range.start && range.start < text.length
    );
    const boundaries = new Set<number>([0, text.length]);
    for (const range of [...highlightRanges, ...linkedRanges]) {
      boundaries.add(Math.min(text.length, range.start));
      boundaries.add(Math.min(text.length, range.end));
    }
    const sorted = Array.from(boundaries).sort((left, right) => left - right);
    return sorted.slice(0, -1).flatMap((start, segmentIndex) => {
      const end = sorted[segmentIndex + 1];
      if (end <= start) return [];
      const highlightRange = highlightRanges.find(
        range => range.start <= start && range.end >= end
      );
      const highlight = highlightRange?.h;
      const associations = linkedRanges.filter(
        range => range.start <= start && range.end >= end
      );
      return [
        {
          start,
          end,
          text: text.slice(start, end),
          highlight,
          endingHighlight: highlightRange?.end === end,
          associations,
          endingAssociations: associations.filter(range => range.end === end),
        },
      ];
    });
  }, [associationRanges, ranges, text]);

  return (
    <p ref={wrapRef} data-pi={index}>
      {segments.map(segment => {
        const h = segment.highlight;
        const firstAssociation = segment.associations[0];
        if (!h && !firstAssociation)
          return <span key={segment.start}>{segment.text}</span>;
        const isConcealed = h
          ? isRecallHighlightConcealed(recall, revealed, h.id)
          : false;
        const reveal = () => {
          if (h) setRevealed(current => revealRecallHighlight(current, h.id));
        };
        const style = h?.style ?? {
          kind: "underline" as const,
          color: "blue",
        };
        const c = swatch(style.color);
        const highlightClass = !h
          ? ""
          : style.kind === "underline"
            ? "hl-underline"
            : style.kind === "background"
              ? "hl-background"
              : style.kind === "color"
                ? "hl-color"
                : "";
        const associationAnchorKeys = Array.from(
          new Set(
            segment.associations.map(relation =>
              passageAnchorKey(relation.anchor)
            )
          )
        );
        const openAssociation = (
          event: React.MouseEvent<HTMLElement>,
          selected?: AssociationRange
        ) => {
          const relation =
            selected ?? segment.endingAssociations[0] ?? firstAssociation;
          if (!relation) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onAssociationClick(
            relation.anchor,
            rect.bottom + 6,
            rect.left + rect.width / 2
          );
        };
        return (
          <span
            key={segment.start}
            role={isConcealed ? "button" : undefined}
            tabIndex={isConcealed ? 0 : undefined}
            aria-label={isConcealed ? "揭示被遮盖的摘录" : undefined}
            data-association-anchor-keys={
              associationAnchorKeys.length > 0
                ? JSON.stringify(associationAnchorKeys)
                : undefined
            }
            data-recall-state={
              recall ? (isConcealed ? "concealed" : "revealed") : undefined
            }
            className={`hl-clickable ${highlightClass} ${h?.noteId ? "hl-citation" : ""} ${firstAssociation ? "hl-association" : ""} ${isConcealed ? "hl-recall-hidden" : ""}`}
            style={
              {
                "--hl-solid": isConcealed ? "transparent" : c.solid,
                "--hl-soft": isConcealed ? "transparent" : c.soft,
              } as React.CSSProperties
            }
            title={
              isConcealed
                ? "点击揭示摘录"
                : recall
                  ? "已揭示摘录"
                  : firstAssociation
                    ? "已建立内容关联，点击关联图标管理"
                    : h?.noteId
                      ? "已引用到笔记，点击管理"
                      : undefined
            }
            onMouseDown={e => {
              if (!isConcealed) return;
              // Reveal before the enclosing selection handler runs. This also
              // prevents a click from becoming a tiny accidental text drag.
              e.preventDefault();
              reveal();
            }}
            onKeyDown={e => {
              if (!isConcealed || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              reveal();
            }}
            onClick={e => {
              if (recall) {
                reveal();
                return;
              }
              if (h) {
                const wrap = wrapRef.current?.closest(".relative");
                const wrect = wrap?.getBoundingClientRect();
                const rect = (e.target as HTMLElement).getBoundingClientRect();
                if (!wrect) return;
                onSegmentClick(
                  h.id,
                  rect.bottom - wrect.top + 6,
                  rect.left - wrect.left + rect.width / 2
                );
              } else openAssociation(e);
            }}
          >
            {segment.text}
            {h?.noteId && segment.endingHighlight && (
              <Quote
                aria-label="引用标记"
                size={10}
                className="mb-0.5 ml-0.5 inline text-primary"
              />
            )}
            {h &&
              segment.endingHighlight &&
              (h.note || (h.aiQa?.length ?? 0) > 0) &&
              style.kind === "none" && (
                <Sparkles
                  size={11}
                  className="mb-0.5 ml-0.5 inline text-primary"
                />
              )}
            {segment.endingAssociations.map(relation => {
              const associationCount = new Set(relation.associationIds).size;
              const relationKey = passageAnchorKey(relation.anchor);
              return (
                <button
                  key={relationKey}
                  type="button"
                  data-association-anchor-key={relationKey}
                  className="association-ball ml-0.5 inline-flex align-middle"
                  aria-label={`管理 ${associationCount} 条内容关联`}
                  title={`${associationCount} 条内容关联`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={event => {
                    event.stopPropagation();
                    openAssociation(event, relation);
                  }}
                >
                  <Link2 size={9} />
                  {associationCount > 1 ? associationCount : null}
                </button>
              );
            })}
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

/** 点击已有书摘的弹层：批注、复习、独立关联、引用、AI 与删除。 */
export function HighlightPopup({
  h,
  top,
  left,
  notes,
  onEditNote,
  onEditName,
  onEditTags,
  onEditCloze,
  onToggleReview,
  onAddToMindMap,
  onAddToOutline,
  associationCount,
  onAssociate,
  onCite,
  onUnlinkCitation,
  onAskAi,
  onDelete,
  onClose,
}: {
  h: Highlight;
  top: number;
  left: number;
  notes: import("@/types").Note[];
  onEditNote: (text: string) => void;
  onEditName: (name: string) => void;
  onEditTags: (tags: string[]) => void;
  onEditCloze: (cloze: string[]) => void;
  onToggleReview: () => void;
  onAddToMindMap: () => void;
  onAddToOutline: () => void;
  associationCount: number;
  onAssociate: () => void;
  onCite: (noteId: string | "new") => Promise<void> | void;
  onUnlinkCitation: () => Promise<void> | void;
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
          <CitationNotePicker
            notes={notes}
            sourceText={h.text}
            onSelect={onCite}
            onClose={() => setCiting(false)}
            embedded
          />
        </div>
      ) : (
        <div
          className="mt-2.5 space-y-1 border-t border-border pt-2"
          role="toolbar"
          aria-label="已有书摘的操作"
        >
          <div className="flex items-center justify-center gap-1">
            <ExpandableSelectionAction
              icon={<MessageSquarePlus size={14} />}
              label={h.note ? "改批注" : "批注"}
              onClick={() => setEditing(true)}
              className="text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
            <ExpandableSelectionAction
              icon={<Tag size={14} />}
              label="标签"
              aria-pressed={tagging}
              onClick={() => setTagging(v => !v)}
              className={
                tagging
                  ? "bg-secondary text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }
            />
            <ExpandableSelectionAction
              icon={<RefreshCw size={14} />}
              label={inReview ? "移出复习" : "加入复习"}
              aria-pressed={inReview}
              onClick={onToggleReview}
              className={
                inReview
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }
            />
            <ExpandableSelectionAction
              icon={<GitBranch size={14} />}
              label="脑图"
              onClick={onAddToMindMap}
              className="text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
          </div>
          <div className="flex items-center justify-center gap-1">
            <ExpandableSelectionAction
              icon={<ListPlus size={14} />}
              label="目录"
              onClick={onAddToOutline}
              className="text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
            <ExpandableSelectionAction
              icon={<Link2 size={14} />}
              label={associationCount ? `关联 ${associationCount}` : "关联"}
              onClick={onAssociate}
              className={
                associationCount
                  ? "bg-sky-500/10 text-sky-700"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }
            />
            {h.noteId ? (
              <ExpandableSelectionAction
                icon={<Unlink size={14} />}
                label="取消引用"
                onClick={() => void onUnlinkCitation()}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              />
            ) : (
              <ExpandableSelectionAction
                icon={<Quote size={14} />}
                label="引用"
                onClick={() => setCiting(true)}
                className="text-muted-foreground hover:bg-secondary hover:text-foreground"
              />
            )}
            <ExpandableSelectionAction
              icon={<Sparkles size={14} />}
              label="问 AI"
              onClick={onAskAi}
              className="font-medium text-primary hover:bg-accent/40"
            />
            <ExpandableSelectionAction
              icon={<Trash2 size={14} />}
              label="删除"
              onClick={onDelete}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            />
          </div>
        </div>
      )}
    </div>
  );
}
