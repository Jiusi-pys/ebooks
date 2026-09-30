import { useMemo } from "react";
import { ArrowUpRight, History } from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import type { ReadingSession } from "@/types";
import {
  formatReadingDuration,
  mergeReadingSessions,
  readingDurationByBook,
  totalReadingDuration,
} from "@/lib/readingTime";

export function ReadingHistoryView({ lib }: { lib: Library }) {
  const booksById = useMemo(
    () => new Map(lib.books.map(book => [book.id, book])),
    [lib.books]
  );
  const sessions = useMemo(
    () =>
      lib.books.reduce(
        (all, book) => mergeReadingSessions(all, book.readingSessions ?? []),
        [] as ReadingSession[]
      ),
    [lib.books]
  );
  const totals = useMemo(() => readingDurationByBook(sessions), [sessions]);
  const recent = useMemo(
    () => [...sessions].sort((a, b) => b.endedAt - a.endedAt).slice(0, 100),
    [sessions]
  );

  return (
    <div className="h-full overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-3">
          <History className="text-primary" size={22} aria-hidden="true" />
          <div>
            <h1 className="font-reading text-2xl font-semibold">阅读记录</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              仅累计阅读器在前台打开的时间；设备间重复区间只计一次。
            </p>
          </div>
        </div>

        <section className="mt-7 rounded-2xl border bg-card p-5">
          <div className="text-xs text-muted-foreground">总阅读时长</div>
          <div className="mt-2 font-reading text-3xl font-semibold">
            {formatReadingDuration(totalReadingDuration(sessions))}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {sessions.length} 段阅读记录 · 最近 100 段显示在下方
          </div>
        </section>

        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold">按书统计</h2>
          {Object.keys(totals).length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              打开一本书开始阅读后，这里会出现阅读记录。
            </div>
          ) : (
            <div className="divide-y rounded-xl border bg-card">
              {Object.entries(totals)
                .sort((a, b) => b[1] - a[1])
                .map(([bookId, duration]) => {
                  const book = booksById.get(bookId);
                  if (!book) return null;
                  return (
                    <button
                      key={bookId}
                      type="button"
                      onClick={() => lib.openReader(bookId)}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/40"
                    >
                      <span className="min-w-0 truncate text-sm">
                        {book.title}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                        {formatReadingDuration(duration)}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
            </div>
          )}
        </section>

        <section className="mt-8 pb-8">
          <h2 className="mb-3 text-sm font-semibold">最近阅读</h2>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无阅读记录</p>
          ) : (
            <div className="divide-y rounded-xl border bg-card">
              {recent.map((session: ReadingSession) => {
                const book = booksById.get(session.bookId);
                if (!book) return null;
                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate">{book.title}</div>
                      <time className="mt-1 block text-xs text-muted-foreground">
                        {new Date(session.startedAt).toLocaleString()}
                      </time>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatReadingDuration(
                        session.endedAt - session.startedAt
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
