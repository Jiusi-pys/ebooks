import { useEffect, useRef } from "react";
import { BookOpen, Columns2, X } from "lucide-react";
import type { Book, ReaderTheme, TypeSettings } from "@/types";
import { fontStack } from "@/lib/reading";
import type { SplitDirection } from "@/lib/splitLayout";
import { PdfCanvasViewer } from "./PdfCanvasViewer";

export interface SplitTarget {
  bookId: string;
  chapterId: string;
}

/**
 * 阅读器分屏的右侧参考窗格：可任选一本书 / 一章对照阅读。
 * 纯参考用途：不改动该书进度、不提供划线（划线请打开主阅读器）。
 */
export function SplitPane({
  books,
  value,
  onChange,
  onClose,
  onSplit,
  canSplit,
  theme,
  type,
}: {
  books: Book[];
  value: SplitTarget;
  onChange: (next: SplitTarget) => void;
  onClose: () => void;
  onSplit: (direction: SplitDirection) => void;
  canSplit: boolean;
  theme: ReaderTheme;
  type: TypeSettings;
}) {
  const book = books.find(b => b.id === value.bookId) ?? books[0];
  const chapter =
    book?.chapters.find(c => c.id === value.chapterId) ?? book?.chapters[0];
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [chapter?.id, book?.id]);

  const isOriginal = book?.format === "pdf" && book.readerMode === "original";

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      style={{
        background: theme.bg,
        color: theme.text,
        borderColor: theme.border,
      }}
    >
      {/* 选择条 */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: theme.border, background: theme.panel }}
      >
        <span
          className="font-meta shrink-0 text-[10px] uppercase tracking-[0.16em]"
          style={{ color: theme.muted }}
        >
          分屏
        </span>
        <select
          value={book?.id ?? ""}
          onChange={e => {
            const nb = books.find(b => b.id === e.target.value);
            onChange({
              bookId: e.target.value,
              chapterId: nb?.chapters[0]?.id ?? "",
            });
          }}
          className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-1.5 text-[12px] outline-none"
          style={{ borderColor: theme.border }}
        >
          {books.map(b => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
        {!isOriginal && (
          <select
            value={chapter?.id ?? ""}
            onChange={e =>
              onChange({ bookId: book?.id ?? "", chapterId: e.target.value })
            }
            className="h-7 w-32 shrink-0 rounded-md border bg-transparent px-1.5 text-[12px] outline-none"
            style={{ borderColor: theme.border }}
          >
            {(book?.chapters ?? []).map((c, i) => (
              <option key={c.id} value={c.id}>
                {String(i + 1).padStart(2, "0")} {c.title}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => onSplit("horizontal")}
          disabled={!canSplit}
          className="shrink-0 rounded-md p-1 hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
          style={{ color: theme.muted }}
          title={canSplit ? "向右拆分此窗格" : "最多支持 3 个窗格"}
        >
          <Columns2 size={14} />
        </button>
        <button
          onClick={() => onSplit("vertical")}
          disabled={!canSplit}
          className="shrink-0 rounded-md p-1 hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
          style={{ color: theme.muted }}
          title={canSplit ? "向下拆分此窗格" : "最多支持 3 个窗格"}
        >
          <Columns2 className="rotate-90" size={14} />
        </button>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md p-1 hover:opacity-70"
          style={{ color: theme.muted }}
          title="关闭分屏"
        >
          <X size={14} />
        </button>
      </div>

      {/* 内容 */}
      {!book || !chapter ? (
        <div
          className="flex flex-1 items-center justify-center text-sm"
          style={{ color: theme.muted }}
        >
          没有可对照的书籍
        </div>
      ) : isOriginal ? (
        <div className="min-h-0 flex-1">
          <PdfCanvasViewer
            key={book.id}
            bookId={book.id}
            initialPage={Math.max(
              1,
              Math.round((book.progress?.ratio ?? 0) * (book.pageCount ?? 1))
            )}
            onProgress={() => undefined}
            onSelectText={() => undefined}
          />
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-[620px] px-7 pb-20 pt-8">
            <div
              className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.18em]"
              style={{ color: theme.muted }}
            >
              {book.author || "佚名"} · {chapter.paragraphs.length} 段
            </div>
            <h2 className="font-reading mb-8 text-center text-[21px] font-bold tracking-wide">
              {chapter.title}
            </h2>
            <div
              className="reader-body"
              style={{
                fontFamily: fontStack(type.fontId),
                fontSize: Math.max(15, type.fontSize - 1),
                lineHeight: type.lineHeight,
                letterSpacing: `${type.letterSpacing}em`,
                fontWeight: type.fontWeight,
              }}
            >
              {chapter.paragraphs.map((p, i) => (
                <p key={i} className="mb-4">
                  {p}
                </p>
              ))}
            </div>
          </article>
        </div>
      )}

      <div
        className="font-meta flex shrink-0 items-center gap-1 border-t px-3 py-1.5 text-[10px]"
        style={{ borderColor: theme.border, color: theme.muted }}
      >
        <BookOpen size={10} />
        参考窗格 · 划线与批注请在主阅读区进行
      </div>
    </section>
  );
}
