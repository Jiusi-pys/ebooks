import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Languages,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { Book, Chapter, ReaderTheme, TypeSettings } from "@/types";
import {
  getChapterTranslation,
  putChapterTranslation,
  translationId,
} from "@/lib/db";
import { fontStack, readerPagePadding } from "@/lib/reading";
import { friendlyAiError } from "@/lib/aiError";
import { useAiConfig } from "@/lib/aiConfig";
import {
  chunkChapterForTranslation,
  inferTargetLanguage,
  interpolateParagraphAnchor,
  paragraphAnchorProgress,
  splitTranslatedParagraphs,
  type BilingualLanguage,
  type ParagraphAnchor,
} from "@/lib/bilingual";
import { cn } from "@/lib/utils";
import { trpc } from "@/providers/trpc";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

type PaneSide = "source" | "translation";

export interface BilingualReaderProps {
  /** Bilingual mode is intended for EPUB/MOBI/AZW3/FB2/TXT/reflow books. */
  book: Book;
  chapterId?: string;
  theme: ReaderTheme;
  type: TypeSettings;
  /** Both panes call this callback when their chapter navigation is used. */
  onNavigateChapter: (chapterId: string) => void;
  /** Debounced semantic progress of whichever pane the reader scrolled. */
  onProgress?: (chapterId: string, ratio: number) => void;
  initialTargetLanguage?: BilingualLanguage;
  onTargetLanguageChange?: (language: BilingualLanguage) => void;
  className?: string;
}

function visibleParagraphAnchor(
  container: HTMLDivElement
): ParagraphAnchor | null {
  const paragraphs = Array.from(
    container.querySelectorAll<HTMLElement>("[data-bilingual-paragraph]")
  );
  if (paragraphs.length === 0) return null;

  const viewportTop = container.getBoundingClientRect().top;
  const element =
    paragraphs.find(
      paragraph => paragraph.getBoundingClientRect().bottom > viewportTop
    ) ?? paragraphs[paragraphs.length - 1];
  const rect = element.getBoundingClientRect();
  const index = Number(element.dataset.bilingualParagraph ?? 0);
  const ratio = Math.min(
    1,
    Math.max(0, (viewportTop - rect.top) / Math.max(1, rect.height))
  );
  return { index, ratio };
}

function scrollToParagraphAnchor(
  container: HTMLDivElement,
  anchor: ParagraphAnchor
) {
  const element = container.querySelector<HTMLElement>(
    `[data-bilingual-paragraph="${anchor.index}"]`
  );
  if (!element) return;
  const viewport = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const top =
    container.scrollTop + rect.top - viewport.top + anchor.ratio * rect.height;
  container.scrollTo({ top: Math.max(0, top), behavior: "instant" });
}

export function BilingualReader({
  book,
  chapterId,
  theme,
  type,
  onNavigateChapter,
  onProgress,
  initialTargetLanguage,
  onTargetLanguageChange,
  className,
}: BilingualReaderProps) {
  const chapterIndex = Math.max(
    0,
    chapterId
      ? book.chapters.findIndex(chapter => chapter.id === chapterId)
      : book.chapters.findIndex(
          chapter => chapter.id === book.progress.chapterId
        )
  );
  const chapter = book.chapters[chapterIndex];
  const [targetLanguage, setTargetLanguage] = useState<BilingualLanguage>(
    () =>
      initialTargetLanguage ??
      inferTargetLanguage(
        chapter?.paragraphs ?? book.chapters[0]?.paragraphs ?? []
      )
  );
  const [translationText, setTranslationText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sourceScrollRef = useRef<HTMLDivElement>(null);
  const translationScrollRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);
  const scrollFrame = useRef<Record<PaneSide, number | null>>({
    source: null,
    translation: null,
  });
  const suppressScroll = useRef<Record<PaneSide, boolean>>({
    source: false,
    translation: false,
  });
  const suppressGeneration = useRef<Record<PaneSide, number>>({
    source: 0,
    translation: 0,
  });
  const progressTimer = useRef<number | null>(null);
  const utils = trpc.useUtils();
  const [aiConfig] = useAiConfig();

  const translatedParagraphs = useMemo(
    () =>
      splitTranslatedParagraphs(
        translationText,
        chapter?.paragraphs.length ?? 0
      ),
    [translationText, chapter?.paragraphs.length]
  );

  const loadTranslation = useCallback(
    async (force: boolean) => {
      const activeChapter = chapter;
      if (!activeChapter) return;
      const requestId = ++requestSequence.current;
      setTranslationText("");
      setError("");
      setLoading(true);

      try {
        if (!force) {
          const cached = await getChapterTranslation(
            book.id,
            activeChapter.id,
            targetLanguage
          ).catch(() => undefined);
          if (requestId !== requestSequence.current) return;
          if (cached?.text.trim()) {
            setTranslationText(cached.text);
            setLoading(false);
            return;
          }
        }

        const chunks = chunkChapterForTranslation(activeChapter.paragraphs);
        if (chunks.length === 0) throw new Error("本章没有可翻译的正文。");

        const translated: string[] = [];
        for (const chunk of chunks) {
          if (requestId !== requestSequence.current) return;
          const response = await utils.client.ai.translate.mutate({
            config: aiConfig,
            text: chunk.text,
            targetLang: targetLanguage,
            mode: "chapter",
          });
          if (requestId !== requestSequence.current) return;
          translated.push(
            ...splitTranslatedParagraphs(
              response.translation,
              chunk.sourceParagraphCount
            )
          );
        }

        const text = translated.join("\n\n").trim();
        if (!text) throw new Error("模型没有返回译文。");
        const now = Date.now();
        await putChapterTranslation({
          id: translationId(book.id, activeChapter.id, targetLanguage),
          bookId: book.id,
          chapterId: activeChapter.id,
          targetLang: targetLanguage,
          text,
          createdAt: now,
          updatedAt: now,
        }).catch(() => undefined);
        if (requestId !== requestSequence.current) return;
        setTranslationText(text);
      } catch (reason) {
        if (requestId !== requestSequence.current) return;
        setError(
          friendlyAiError(reason, "章节翻译失败，请检查 AI 设置后重试。")
        );
      } finally {
        if (requestId === requestSequence.current) setLoading(false);
      }
    },
    [aiConfig, book.id, chapter, targetLanguage, utils]
  );

  useEffect(() => {
    void loadTranslation(false);
    return () => {
      requestSequence.current += 1;
    };
  }, [loadTranslation]);

  useEffect(() => {
    sourceScrollRef.current?.scrollTo({ top: 0 });
    translationScrollRef.current?.scrollTo({ top: 0 });
  }, [chapter?.id]);

  const suppressNextScroll = useCallback((side: PaneSide) => {
    const generation = ++suppressGeneration.current[side];
    suppressScroll.current[side] = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (suppressGeneration.current[side] === generation) {
          suppressScroll.current[side] = false;
        }
      });
    });
  }, []);

  const synchronizeFrom = useCallback(
    (side: PaneSide) => {
      if (!chapter) return;
      const source =
        side === "source"
          ? sourceScrollRef.current
          : translationScrollRef.current;
      const target =
        side === "source"
          ? translationScrollRef.current
          : sourceScrollRef.current;
      const sourceCount =
        side === "source"
          ? chapter.paragraphs.length
          : translatedParagraphs.length;
      const targetCount =
        side === "source"
          ? translatedParagraphs.length
          : chapter.paragraphs.length;
      if (!source || !target || sourceCount === 0 || targetCount === 0) return;

      const anchor = visibleParagraphAnchor(source);
      if (!anchor) return;
      const targetSide: PaneSide = side === "source" ? "translation" : "source";
      suppressNextScroll(targetSide);
      scrollToParagraphAnchor(
        target,
        interpolateParagraphAnchor(anchor, sourceCount, targetCount)
      );

      if (onProgress) {
        if (progressTimer.current) window.clearTimeout(progressTimer.current);
        const ratio = paragraphAnchorProgress(anchor, sourceCount);
        progressTimer.current = window.setTimeout(
          () => onProgress(chapter.id, ratio),
          350
        );
      }
    },
    [chapter, onProgress, suppressNextScroll, translatedParagraphs.length]
  );

  const onPaneScroll = useCallback(
    (side: PaneSide) => {
      if (suppressScroll.current[side]) {
        suppressScroll.current[side] = false;
        return;
      }
      if (scrollFrame.current[side] !== null) return;
      scrollFrame.current[side] = requestAnimationFrame(() => {
        scrollFrame.current[side] = null;
        synchronizeFrom(side);
      });
    },
    [synchronizeFrom]
  );

  useEffect(() => {
    if (translatedParagraphs.length === 0) return;
    const frame = requestAnimationFrame(() => synchronizeFrom("source"));
    return () => cancelAnimationFrame(frame);
  }, [synchronizeFrom, translatedParagraphs.length]);

  useEffect(
    () => () => {
      requestSequence.current += 1;
      if (scrollFrame.current.source !== null)
        cancelAnimationFrame(scrollFrame.current.source);
      if (scrollFrame.current.translation !== null)
        cancelAnimationFrame(scrollFrame.current.translation);
      if (progressTimer.current) window.clearTimeout(progressTimer.current);
    },
    []
  );

  if (!chapter) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        这本书没有可用于双语阅读的正文。
      </div>
    );
  }

  const previous = book.chapters[chapterIndex - 1];
  const next = book.chapters[chapterIndex + 1];
  const readerStyle = {
    fontFamily: fontStack(type.fontId),
    fontSize: type.fontSize,
    lineHeight: type.lineHeight,
    letterSpacing: `${type.letterSpacing}em`,
    fontWeight: type.fontWeight,
  };
  const pagePadding = readerPagePadding(type.pageMargin);

  const changeLanguage = (language: BilingualLanguage) => {
    setTargetLanguage(language);
    onTargetLanguageChange?.(language);
  };

  return (
    <ResizablePanelGroup
      id={`bilingual:${book.id}`}
      orientation="horizontal"
      className={cn("min-h-0 min-w-0", className)}
      style={{ background: theme.bg, color: theme.text }}
    >
      <ResizablePanel defaultSize="50%" minSize="25%">
        <ReadingPane
          side="source"
          label="原文"
          chapter={chapter}
          chapterIndex={chapterIndex}
          chapterCount={book.chapters.length}
          paragraphs={chapter.paragraphs}
          scrollRef={sourceScrollRef}
          theme={theme}
          readerStyle={readerStyle}
          pagePadding={pagePadding}
          previous={previous}
          next={next}
          onNavigateChapter={onNavigateChapter}
          onScroll={() => onPaneScroll("source")}
        />
      </ResizablePanel>

      <ResizableHandle
        withHandle
        className="z-20 bg-primary/25"
        aria-label="调整原文与译文宽度"
      />

      <ResizablePanel defaultSize="50%" minSize="25%">
        <section
          className="flex h-full min-h-0 flex-col"
          style={{ background: theme.bg, color: theme.text }}
        >
          <div
            className="flex h-11 shrink-0 items-center gap-2 border-b px-3"
            style={{ background: theme.panel, borderColor: theme.border }}
          >
            <Languages size={14} className="shrink-0 text-primary" />
            <span
              className="font-meta text-[11px]"
              style={{ color: theme.muted }}
            >
              译文
            </span>
            <div
              className="ml-auto flex overflow-hidden rounded-full border"
              style={{ borderColor: theme.border }}
            >
              {(["中文", "English"] as const).map(language => (
                <button
                  key={language}
                  type="button"
                  aria-pressed={targetLanguage === language}
                  onClick={() => changeLanguage(language)}
                  className={cn(
                    "px-2.5 py-1 text-[11px] transition-colors",
                    targetLanguage === language &&
                      "bg-primary text-primary-foreground"
                  )}
                  style={
                    targetLanguage === language
                      ? undefined
                      : { color: theme.muted }
                  }
                >
                  {language === "中文" ? "中" : "EN"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void loadTranslation(true)}
              disabled={loading}
              className="rounded-md p-1.5 hover:opacity-70 disabled:opacity-40"
              style={{ color: theme.muted }}
              title="重新翻译本章"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          </div>

          {loading ? (
            <TranslationState theme={theme}>
              <Loader2 size={16} className="animate-spin text-primary" />
              正在翻译本章…
            </TranslationState>
          ) : error ? (
            <TranslationState theme={theme}>
              <AlertCircle size={16} className="text-destructive" />
              <span className="max-w-sm text-center">{error}</span>
              <button
                type="button"
                onClick={() => void loadTranslation(true)}
                className="mt-1 rounded-full bg-primary px-3 py-1 text-xs text-primary-foreground"
              >
                重试
              </button>
            </TranslationState>
          ) : (
            <div
              ref={translationScrollRef}
              className="min-h-0 flex-1 overflow-y-auto"
              onScroll={() => onPaneScroll("translation")}
            >
              <ChapterBody
                chapter={chapter}
                chapterIndex={chapterIndex}
                chapterCount={book.chapters.length}
                paragraphs={translatedParagraphs}
                label={targetLanguage}
                theme={theme}
                readerStyle={readerStyle}
                pagePadding={pagePadding}
              />
            </div>
          )}

          <ChapterNavigation
            previous={previous}
            next={next}
            theme={theme}
            onNavigateChapter={onNavigateChapter}
          />
        </section>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ReadingPane({
  side,
  label,
  chapter,
  chapterIndex,
  chapterCount,
  paragraphs,
  scrollRef,
  theme,
  readerStyle,
  pagePadding,
  previous,
  next,
  onNavigateChapter,
  onScroll,
}: {
  side: PaneSide;
  label: string;
  chapter: Chapter;
  chapterIndex: number;
  chapterCount: number;
  paragraphs: readonly string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  theme: ReaderTheme;
  readerStyle: React.CSSProperties;
  pagePadding: string;
  previous?: Chapter;
  next?: Chapter;
  onNavigateChapter: (chapterId: string) => void;
  onScroll: () => void;
}) {
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      style={{ background: theme.bg, color: theme.text }}
      data-bilingual-side={side}
    >
      <div
        className="font-meta flex h-11 shrink-0 items-center border-b px-3 text-[11px]"
        style={{
          background: theme.panel,
          borderColor: theme.border,
          color: theme.muted,
        }}
      >
        {label}
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={onScroll}
      >
        <ChapterBody
          chapter={chapter}
          chapterIndex={chapterIndex}
          chapterCount={chapterCount}
          paragraphs={paragraphs}
          label={label}
          theme={theme}
          readerStyle={readerStyle}
          pagePadding={pagePadding}
        />
      </div>
      <ChapterNavigation
        previous={previous}
        next={next}
        theme={theme}
        onNavigateChapter={onNavigateChapter}
      />
    </section>
  );
}

function ChapterBody({
  chapter,
  chapterIndex,
  chapterCount,
  paragraphs,
  label,
  theme,
  readerStyle,
  pagePadding,
}: {
  chapter: Chapter;
  chapterIndex: number;
  chapterCount: number;
  paragraphs: readonly string[];
  label: string;
  theme: ReaderTheme;
  readerStyle: React.CSSProperties;
  pagePadding: string;
}) {
  return (
    <article
      className="mx-auto max-w-[680px] pb-20 pt-9"
      style={{ paddingInline: pagePadding }}
    >
      <h2 className="font-reading mb-2 text-center text-[22px] font-bold tracking-wide">
        {chapter.title}
      </h2>
      <div
        className="font-meta mb-9 text-center text-[10px] uppercase tracking-[0.18em]"
        style={{ color: theme.muted }}
      >
        {label} · {chapterIndex + 1} / {chapterCount}
      </div>
      <div className="reader-body" style={readerStyle}>
        {paragraphs.map((paragraph, index) => (
          <p
            key={index}
            data-bilingual-paragraph={index}
            className="whitespace-pre-wrap"
          >
            {paragraph}
          </p>
        ))}
      </div>
    </article>
  );
}

function ChapterNavigation({
  previous,
  next,
  theme,
  onNavigateChapter,
}: {
  previous?: Chapter;
  next?: Chapter;
  theme: ReaderTheme;
  onNavigateChapter: (chapterId: string) => void;
}) {
  return (
    <div
      className="flex h-11 shrink-0 items-center justify-between border-t px-3"
      style={{ background: theme.panel, borderColor: theme.border }}
    >
      <button
        type="button"
        disabled={!previous}
        onClick={() => previous && onNavigateChapter(previous.id)}
        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-opacity hover:opacity-70 disabled:opacity-30"
        style={{ color: theme.muted }}
      >
        <ChevronLeft size={13} /> 上一章
      </button>
      <button
        type="button"
        disabled={!next}
        onClick={() => next && onNavigateChapter(next.id)}
        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-opacity hover:opacity-70 disabled:opacity-30"
        style={{ color: theme.muted }}
      >
        下一章 <ChevronRight size={13} />
      </button>
    </div>
  );
}

function TranslationState({
  theme,
  children,
}: {
  theme: ReaderTheme;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-sm"
      style={{ color: theme.muted }}
    >
      {children}
    </div>
  );
}
