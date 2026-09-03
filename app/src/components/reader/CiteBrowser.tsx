import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  ChevronLeft,
  ChevronRight,
  FileText,
  Quote,
  Search,
} from "lucide-react";
import type { Book, CitationLevel, Note, PdfHighlightAnchor } from "@/types";

/** 三级引用选择的结果：书 → 章节 → 章节内段落 */
export interface CitationTarget {
  level: CitationLevel;
  bookId: string;
  bookTitle: string;
  chapterId?: string;
  chapterTitle?: string;
  paraIndex?: number;
  start?: number;
  end?: number;
  pdfAnchor?: PdfHighlightAnchor;
  text?: string;
}

interface Props {
  books: Book[];
  currentBookId?: string;
  notes: Note[];
  /** 选中三级内容后回调 */
  onSelect: (target: CitationTarget, noteId: string | "new") => void;
  onClose: () => void;
}

type Level =
  | { depth: 1 }
  | { depth: 2; book: Book }
  | { depth: 3; book: Book; chapterIdx: number };

/**
 * 三级引用浏览器：① 库中书籍 → ② 该书章节 → ③ 章节内文段。
 * 书籍和章节行均可在当前层直接引用，也可继续进入下一级精确选择。
 * 每一级都支持模糊搜索（书名/作者、章节标题、文段内容）。
 * 进入第三级前先选目标笔记（顶部下拉，默认新建书摘笔记）。
 */
export function CiteBrowser({
  books,
  currentBookId,
  notes,
  onSelect,
  onClose,
}: Props) {
  const [level, setLevel] = useState<Level>({ depth: 1 });
  const [query, setQuery] = useState("");
  const [noteId, setNoteId] = useState<string>("new");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, [level.depth]);

  const navigateLevel = (next: Level) => {
    setQuery("");
    setLevel(next);
  };

  const q = query.trim().toLowerCase();

  const bookList = useMemo(
    () =>
      books.filter(
        b =>
          !q ||
          b.title.toLowerCase().includes(q) ||
          (b.author || "").toLowerCase().includes(q)
      ),
    [books, q]
  );

  const chapterList = useMemo(() => {
    if (level.depth === 1)
      return [] as { c: Book["chapters"][number]; i: number }[];
    return level.book.chapters
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !q || c.title.toLowerCase().includes(q));
  }, [level, q]);

  const paraList = useMemo(() => {
    if (level.depth !== 3) return [] as { p: string; i: number }[];
    const ch = level.book.chapters[level.chapterIdx];
    if (!ch) return [];
    return ch.paragraphs
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.trim().length > 0)
      .filter(({ p }) => !q || p.toLowerCase().includes(q));
  }, [level, q]);

  const back = () => {
    if (level.depth === 3) navigateLevel({ depth: 2, book: level.book });
    else if (level.depth === 2) navigateLevel({ depth: 1 });
  };

  const citeBook = (book: Book) =>
    onSelect(
      {
        level: "book",
        bookId: book.id,
        bookTitle: book.title,
      },
      noteId
    );

  const citeChapter = (book: Book, chapterIdx: number) => {
    const selectedChapter = book.chapters[chapterIdx];
    if (!selectedChapter) return;
    onSelect(
      {
        level: "chapter",
        bookId: book.id,
        bookTitle: book.title,
        chapterId: selectedChapter.id,
        chapterTitle: selectedChapter.title,
      },
      noteId
    );
  };

  const crumb =
    level.depth === 1
      ? "选择书籍"
      : level.depth === 2
        ? level.book.title
        : `${level.book.title} · ${level.book.chapters[level.chapterIdx]?.title ?? ""}`;

  return (
    <div
      className="float-pop absolute z-40 -translate-x-1/2 rounded-lg border border-border bg-popover"
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="w-[340px] p-3">
        {/* 头部：返回 + 面包屑 */}
        <div className="mb-2 flex items-center gap-1.5">
          {level.depth > 1 && (
            <button
              onClick={back}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <ChevronLeft size={14} />
            </button>
          )}
          <span className="font-meta truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {crumb}
          </span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {/* 目标笔记 */}
        <div className="mb-2 flex items-center gap-2">
          <span className="font-meta shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            引用到
          </span>
          <select
            value={noteId}
            onChange={e => setNoteId(e.target.value)}
            className="h-7 min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-primary/60"
          >
            <option value="new">＋ 新建书摘笔记</option>
            {notes.map(n => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </div>

        {/* 模糊搜索 */}
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-card px-2">
          <Search size={12} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={
              level.depth === 1
                ? "搜索书名 / 作者…"
                : level.depth === 2
                  ? "搜索章节标题…"
                  : "搜索文段内容…"
            }
            className="h-7 w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {/* 列表 */}
        <div className="max-h-56 overflow-y-auto">
          {level.depth === 1 &&
            (bookList.length ? (
              bookList.map(b => (
                <div
                  key={b.id}
                  className="group flex items-center rounded-md hover:bg-secondary"
                >
                  <button
                    onClick={() => navigateLevel({ depth: 2, book: b })}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                    aria-label={`展开《${b.title}》的章节`}
                  >
                    <BookMarked
                      size={13}
                      className="shrink-0 text-primary/70"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">
                        {b.title}
                      </span>
                      <span className="font-meta block text-[10px] text-muted-foreground">
                        {b.author || "佚名"} · {b.chapters.length} 章
                        {b.id === currentBookId ? " · 在读" : ""}
                      </span>
                    </span>
                    <ChevronRight
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                  </button>
                  <button
                    onClick={() => citeBook(b)}
                    className="mr-1.5 inline-flex shrink-0 items-center gap-1 rounded border border-border bg-card px-1.5 py-1 text-[10px] text-muted-foreground hover:border-primary/60 hover:text-primary"
                    title={`引用整本《${b.title}》`}
                    aria-label={`引用整本《${b.title}》`}
                  >
                    <Quote size={10} /> 整书
                  </button>
                </div>
              ))
            ) : (
              <EmptyRow text={q ? "没有匹配的书籍" : "书架是空的"} />
            ))}

          {level.depth === 2 &&
            (chapterList.length ? (
              chapterList.map(({ c, i }) => (
                <div
                  key={c.id}
                  className="group flex items-center rounded-md hover:bg-secondary"
                >
                  <button
                    onClick={() =>
                      navigateLevel({
                        depth: 3,
                        book: level.book,
                        chapterIdx: i,
                      })
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                    aria-label={`展开章节“${c.title}”的内容`}
                  >
                    <span className="font-meta w-6 shrink-0 text-[10px] text-muted-foreground">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">
                      {c.title}
                    </span>
                    <span className="font-meta shrink-0 text-[10px] text-muted-foreground">
                      {c.paragraphs.length} 段
                    </span>
                    <ChevronRight
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                  </button>
                  <button
                    onClick={() => citeChapter(level.book, i)}
                    className="mr-1.5 inline-flex shrink-0 items-center gap-1 rounded border border-border bg-card px-1.5 py-1 text-[10px] text-muted-foreground hover:border-primary/60 hover:text-primary"
                    title={`引用章节“${c.title}”`}
                    aria-label={`引用章节“${c.title}”`}
                  >
                    <Quote size={10} /> 章节
                  </button>
                </div>
              ))
            ) : (
              <EmptyRow text="没有匹配的章节" />
            ))}

          {level.depth === 3 &&
            (paraList.length ? (
              paraList.map(({ p, i }) => (
                <button
                  key={i}
                  onClick={() =>
                    onSelect(
                      {
                        level: "content",
                        bookId: level.book.id,
                        bookTitle: level.book.title,
                        chapterId: level.book.chapters[level.chapterIdx].id,
                        chapterTitle:
                          level.book.chapters[level.chapterIdx].title,
                        paraIndex: i,
                        text: p,
                      },
                      noteId
                    )
                  }
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
                >
                  <FileText
                    size={11}
                    className="mt-0.5 shrink-0 text-muted-foreground/60"
                  />
                  <span className="min-w-0 flex-1 text-[12px] leading-5 text-foreground/85">
                    {highlightMatch(p, query)}
                  </span>
                </button>
              ))
            ) : (
              <EmptyRow text="没有匹配的文段" />
            ))}
        </div>
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
      {text}
    </div>
  );
}

/** 搜索命中的子串高亮 */
function highlightMatch(text: string, q: string) {
  const t = q.trim();
  if (!t) return <>{text}</>;
  const i = text.toLowerCase().indexOf(t.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-primary/20 px-0.5 text-foreground">
        {text.slice(i, i + t.length)}
      </mark>
      {text.slice(i + t.length)}
    </>
  );
}
