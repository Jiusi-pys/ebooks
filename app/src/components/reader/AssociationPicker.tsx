import { useState } from "react";
import { ArrowRight, ArrowRightLeft, Link2, Search, X } from "lucide-react";
import {
  passageAnchorFromHighlight,
  passageAnchorKey,
  targetSentenceCandidates,
} from "@/lib/associations";
import type {
  AssociationDirection,
  Book,
  Chapter,
  Highlight,
  PassageAnchor,
} from "@/types";

interface Props {
  books: readonly Book[];
  highlights?: readonly Highlight[];
  source: PassageAnchor;
  onSelect: (
    target: PassageAnchor,
    direction: AssociationDirection,
    label: string
  ) => Promise<void> | void;
  onClose: () => void;
}

function associationChapters(
  book: Book,
  highlights: readonly Highlight[],
  source: PassageAnchor
): Chapter[] {
  const chapters = new Map(book.chapters.map(chapter => [chapter.id, chapter]));
  const anchors = highlights.flatMap(highlight => {
    if (highlight.bookId !== book.id) return [];
    const anchor = passageAnchorFromHighlight(highlight);
    return anchor ? [anchor] : [];
  });
  if (source.bookId === book.id) anchors.unshift(source);
  for (const anchor of anchors) {
    if (chapters.has(anchor.chapterId)) continue;
    chapters.set(anchor.chapterId, {
      id: anchor.chapterId,
      title:
        anchor.kind === "pdf"
          ? anchor.chapterTitle.replace(/ · 第 \d+ 页$/u, "") || "原版 PDF"
          : anchor.chapterTitle,
      paragraphs: [],
    });
  }
  return Array.from(chapters.values());
}

/**
 * Pick the second endpoint of a passage-to-passage association.
 *
 * Unlike citation, this flow never asks for a note. It keeps the source fixed,
 * then resolves a precise sentence anchor in another (or the same) book.
 */
export function AssociationPicker({
  books,
  highlights = [],
  source,
  onSelect,
  onClose,
}: Props) {
  const initialBook =
    books.find(
      book =>
        book.id !== source.bookId &&
        associationChapters(book, highlights, source).length > 0
    ) ??
    books.find(book => book.id === source.bookId) ??
    books[0];
  const initialChapters = initialBook
    ? associationChapters(initialBook, highlights, source)
    : [];
  const initialChapter =
    initialChapters.find(chapter => chapter.id === source.chapterId) ??
    initialChapters[0];
  const [bookId, setBookId] = useState(initialBook?.id ?? "");
  const [chapterId, setChapterId] = useState(initialChapter?.id ?? "");
  const [query, setQuery] = useState("");
  const [direction, setDirection] =
    useState<AssociationDirection>("bidirectional");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedBook = books.find(book => book.id === bookId) ?? books[0];
  const selectedChapters = selectedBook
    ? associationChapters(selectedBook, highlights, source)
    : [];
  const selectedChapter =
    selectedChapters.find(chapter => chapter.id === chapterId) ??
    selectedChapters[0];
  const sourceBook = books.find(book => book.id === source.bookId);

  const candidates = (() => {
    if (!selectedBook || !selectedChapter) return [];
    const sourceKey = passageAnchorKey(source);
    const sentenceCandidates =
      selectedBook.format === "pdf" && selectedBook.readerMode === "original"
        ? []
        : targetSentenceCandidates(selectedBook, {
            chapterId: selectedChapter.id,
            query,
            limit: 120,
          });
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const preciseHighlights = highlights.flatMap(highlight => {
      if (
        highlight.bookId !== selectedBook.id ||
        highlight.chapterId !== selectedChapter.id
      )
        return [];
      const anchor = passageAnchorFromHighlight(highlight);
      if (
        !anchor ||
        (normalizedQuery &&
          !anchor.text.toLocaleLowerCase().includes(normalizedQuery))
      )
        return [];
      return [anchor];
    });
    return Array.from(
      new Map(
        [...preciseHighlights, ...sentenceCandidates]
          .filter(candidate => passageAnchorKey(candidate) !== sourceKey)
          .map(candidate => [passageAnchorKey(candidate), candidate])
      ).values()
    ).slice(0, 120);
  })();

  const choose = async (target: PassageAnchor) => {
    setBusy(true);
    setError("");
    try {
      await onSelect(target, direction, label.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "建立关联失败，请重试");
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="选择关联目标"
      className="float-pop relative z-50 max-h-[min(640px,calc(100vh-32px))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
      style={{ width: "min(680px, calc(100vw - 32px))" }}
      onMouseDown={event => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Link2 size={15} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">建立内容关联</h2>
          <p className="text-[10.5px] text-muted-foreground">
            关联连接两处原文，不会将内容引用到笔记。
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭关联选择器"
          className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
        <div className="min-w-0 space-y-3">
          <section className="rounded-lg border border-primary/25 bg-primary/5 p-3">
            <div className="font-meta mb-1 text-[10px] uppercase tracking-[0.14em] text-primary">
              A · 关联起点
            </div>
            <p className="font-reading line-clamp-4 text-[12px] leading-5">
              「{source.text}」
            </p>
            <p className="font-meta mt-1.5 truncate text-[10px] text-muted-foreground">
              {sourceBook ? `《${sourceBook.title}》 · ` : ""}
              {source.chapterTitle}
            </p>
          </section>

          <fieldset>
            <legend className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              关联方向
            </legend>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
              <button
                type="button"
                aria-pressed={direction === "bidirectional"}
                onClick={() => setDirection("bidirectional")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] transition-colors ${
                  direction === "bidirectional"
                    ? "bg-card font-medium text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ArrowRightLeft size={12} /> 双向
              </button>
              <button
                type="button"
                aria-pressed={direction === "source-to-target"}
                onClick={() => setDirection("source-to-target")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] transition-colors ${
                  direction === "source-to-target"
                    ? "bg-card font-medium text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ArrowRight size={12} /> 单向 A→B
              </button>
            </div>
          </fieldset>

          <label className="block">
            <span className="font-meta mb-1.5 block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              关系说明 · 可选
            </span>
            <input
              value={label}
              maxLength={160}
              onChange={event => setLabel(event.target.value)}
              placeholder="例如：观点相似、反例、因果关系"
              className="h-8 w-full rounded-md border border-border bg-card px-2.5 text-[12px] outline-none focus:border-primary/60"
            />
          </label>
        </div>

        <section className="min-w-0">
          <div className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            B · 选择关联目标
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0">
              <span className="sr-only">关联目标书籍</span>
              <select
                aria-label="关联目标书籍"
                value={selectedBook?.id ?? ""}
                onChange={event => {
                  const next = books.find(
                    book => book.id === event.target.value
                  );
                  const nextChapters = next
                    ? associationChapters(next, highlights, source)
                    : [];
                  setBookId(event.target.value);
                  setChapterId(nextChapters[0]?.id ?? "");
                  setQuery("");
                }}
                className="h-8 w-full truncate rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-primary/60"
              >
                {books.map(book => (
                  <option key={book.id} value={book.id}>
                    {book.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0">
              <span className="sr-only">关联目标章节</span>
              <select
                aria-label="关联目标章节"
                value={selectedChapter?.id ?? ""}
                onChange={event => {
                  setChapterId(event.target.value);
                  setQuery("");
                }}
                className="h-8 w-full truncate rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-primary/60"
              >
                {selectedChapters.map((chapter, index) => (
                  <option key={chapter.id} value={chapter.id}>
                    {String(index + 1).padStart(2, "0")} {chapter.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-card px-2.5">
            <Search size={12} className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="在本章搜索句子…"
              aria-label="搜索关联目标句子"
              className="h-8 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
            />
          </div>

          <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-border p-1">
            {!selectedBook ? (
              <Empty text="书架中还没有可关联的书籍" />
            ) : !selectedChapter ? (
              <Empty text="这本书没有可关联的章节" />
            ) : candidates.length === 0 ? (
              <Empty
                text={
                  query.trim()
                    ? "没有匹配的句子"
                    : "当前章节没有其他可关联的句子"
                }
              />
            ) : (
              candidates.map(candidate => (
                <button
                  key={passageAnchorKey(candidate)}
                  type="button"
                  disabled={busy}
                  aria-label={`选择关联目标：${candidate.text}`}
                  onClick={() => void choose(candidate)}
                  className="group flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-secondary disabled:opacity-40"
                >
                  <Link2
                    size={11}
                    className="mt-1 shrink-0 text-muted-foreground group-hover:text-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-reading block text-[12px] leading-5">
                      {highlightMatch(candidate.text, query)}
                    </span>
                    <span className="font-meta mt-0.5 block text-[9.5px] text-muted-foreground">
                      {candidate.kind === "pdf" ? (
                        <>原版 PDF · 第 {candidate.pdfAnchor.page} 页</>
                      ) : (
                        <>
                          第 {candidate.paraIndex + 1} 段 · 字符{" "}
                          {candidate.start}–{candidate.end}
                        </>
                      )}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          {error && (
            <p className="mt-1.5 text-[11px] text-destructive">{error}</p>
          )}
          <p className="font-meta mt-1.5 text-[9.5px] leading-4 text-muted-foreground/75">
            {selectedBook?.format === "pdf" &&
            selectedBook.readerMode === "original"
              ? "原版 PDF 以已有精确书摘作为目标；如列表为空，请先在目标页划选原文。"
              : "选择一个句子即建立关联；与 A 完全相同的位置已自动排除。"}
          </p>
        </section>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="px-3 py-8 text-center text-[11px] text-muted-foreground">
      {text}
    </p>
  );
}

function highlightMatch(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-primary/20 px-0.5 text-foreground">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}
