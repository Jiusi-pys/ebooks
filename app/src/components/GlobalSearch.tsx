import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import {
  searchLibrary,
  type SearchResponse,
  type SearchResult,
  type SearchContentType,
  type SearchScope,
} from "@/lib/search";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

export function GlobalSearch({
  lib,
  immersive = false,
}: {
  lib: Library;
  immersive?: boolean;
}) {
  const currentBook =
    lib.route.view === "reader"
      ? lib.books.find(b => b.id === lib.route.bookId)
      : undefined;
  const currentSet = lib.studySets.find(s => s.id === lib.route.studySetId);
  const candidateSets = currentBook
    ? lib.studySets.filter(s => s.bookIds.includes(currentBook.id))
    : lib.studySets;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>(
    currentBook ? "book" : currentSet ? "studySet" : "all"
  );
  const [contentType, setContentType] = useState<SearchContentType>("all");
  const [setId, setSetId] = useState(
    currentSet?.id ?? (candidateSets.length === 1 ? candidateSets[0].id : "")
  );
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const validScope =
    scope !== "studySet" || lib.studySets.some(s => s.id === setId);

  useEffect(() => {
    alive.current = true;
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => {
      alive.current = false;
      controller.current?.abort();
      window.removeEventListener("keydown", shortcut);
    };
  }, []);

  function invalidate() {
    controller.current?.abort();
    setBusy(false);
    setResponse(null);
    setError("");
  }

  async function submit() {
    controller.current?.abort();
    const run = new AbortController();
    controller.current = run;
    setBusy(true);
    setResponse(null);
    setError("");
    setProgress("正在搜索…");
    try {
      const result = await searchLibrary(
        lib,
        query,
        {
          scope,
          bookId: currentBook?.id,
          studySetId: setId,
          contentType,
        },
        {
          signal: run.signal,
          onProgress: message => {
            if (!run.signal.aborted) setProgress(message);
          },
          pdfPages: async function* (book, signal) {
            const { searchPdfPages } = await import("@/lib/searchPdf");
            signal?.throwIfAborted();
            yield* searchPdfPages(book, signal);
          },
        }
      );
      if (!run.signal.aborted) setResponse(result);
    } catch (cause) {
      if (!run.signal.aborted)
        setError(cause instanceof Error ? cause.message : "搜索失败，请重试");
    } finally {
      if (!run.signal.aborted) setBusy(false);
    }
  }

  async function openResult(result: SearchResult) {
    setOpening(true);
    setError("");
    try {
      const book = lib.books.find(b => b.id === result.route.bookId);
      if (
        book?.format === "pdf" &&
        result.readerMode &&
        book.readerMode !== result.readerMode
      ) {
        if (!(await lib.setReaderMode(book.id, result.readerMode)))
          throw new Error("无法切换到搜索结果对应的阅读模式");
      }
      if (!alive.current) return;
      setOpen(false);
      lib.navigate({ ...result.route, outlineNavigationKey: Date.now() });
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "打开结果失败，请重试"
        );
    } finally {
      if (alive.current) setOpening(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        setOpen(value);
        if (!value) {
          controller.current?.abort();
          setBusy(false);
        }
      }}
    >
      <div
        className={
          immersive
            ? "sr-only focus-within:not-sr-only"
            : "flex shrink-0 items-center border-b border-border/60 px-4 py-2 pl-16 transition-[margin] duration-200 motion-reduce:transition-none md:pl-4"
        }
        style={
          immersive
            ? undefined
            : { marginLeft: "var(--reader-outline-offset, 0px)" }
        }
      >
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label="全局搜索"
            className="flex w-full max-w-xl items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Search size={16} />
            <span className="flex-1 truncate">搜索书摘、批注、问答与正文</span>
          </button>
        </DialogTrigger>
      </div>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-4 bg-card sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>全局搜索</DialogTitle>
          <DialogDescription>
            按书籍范围和内容类型搜索书摘、批注、问答与正文。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={event => {
            event.preventDefault();
            if (query.trim() && validScope && !opening) void submit();
          }}
          className="space-y-3"
        >
          <div className="flex gap-2">
            <input
              autoFocus
              aria-label="搜索内容"
              placeholder="输入关键词，按 Enter 搜索"
              value={query}
              onChange={event => {
                invalidate();
                setQuery(event.target.value);
              }}
              className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={!query.trim() || !validScope || busy || opening}
              className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40"
            >
              搜索
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="global-search-scope">搜索范围</label>
            <select
              id="global-search-scope"
              aria-label="搜索范围"
              value={scope}
              onChange={event => {
                invalidate();
                setScope(event.target.value as SearchScope);
              }}
              className="rounded-md border bg-background px-2 py-1.5"
            >
              <option value="book" disabled={!currentBook}>
                本书
              </option>
              <option value="studySet" disabled={!lib.studySets.length}>
                本合集
              </option>
              <option value="all">文库全部内容</option>
            </select>
            <label htmlFor="global-search-content-type">结果类型</label>
            <select
              id="global-search-content-type"
              aria-label="结果类型"
              value={contentType}
              onChange={event => {
                invalidate();
                setContentType(event.target.value as SearchContentType);
              }}
              className="rounded-md border bg-background px-2 py-1.5"
            >
              <option value="all">全部内容</option>
              <option value="mark">书摘</option>
              <option value="note">批注</option>
              <option value="qa">问答</option>
            </select>
            {scope === "book" && (
              <span className="truncate text-muted-foreground">
                {currentBook?.title}
              </span>
            )}
            {scope === "studySet" && (
              <select
                aria-label="选择学习集"
                value={setId}
                onChange={event => {
                  invalidate();
                  setSetId(event.target.value);
                }}
                className="max-w-full rounded-md border bg-background px-2 py-1.5"
              >
                <option value="" disabled>
                  请选择学习集
                </option>
                {lib.studySets.map(set => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {scope !== "all" && contentType === "all" && (
            <p className="text-xs text-muted-foreground">
              笔记按书籍引用关联纳入范围；未关联的笔记请在“文库全部内容”中搜索。
            </p>
          )}
        </form>
        <div
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 size={15} className="animate-spin" />
              {progress}
              <button className="ml-auto text-primary" onClick={invalidate}>
                取消
              </button>
            </span>
          ) : response ? (
            `找到 ${response.total} 条结果${response.truncated ? "，显示前 200 条，请缩小范围或细化关键词" : ""}`
          ) : (
            "输入关键词后点击搜索，每个命中段落显示一条结果。"
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {response?.warnings.map(warning => (
            <p
              key={warning}
              className="mb-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground"
            >
              {warning}
            </p>
          ))}
          {response?.total === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              未找到匹配内容，请尝试其他关键词或搜索范围。
            </p>
          )}
          <ul className="space-y-2">
            {response?.results.map(result => (
              <li key={result.id}>
                <button
                  data-search-result
                  type="button"
                  disabled={opening}
                  onClick={() => void openResult(result)}
                  className="w-full rounded-lg border border-border/60 p-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="shrink-0 text-xs text-primary">
                      {result.kind}
                    </span>
                    <span className="truncate text-sm font-medium">
                      {result.title}
                    </span>
                  </span>
                  {result.location && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {result.location}
                    </span>
                  )}
                  <span className="mt-2 block whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {result.snippet.slice(0, result.matchStart)}
                    <mark className="rounded-sm bg-primary/20 text-foreground">
                      {result.snippet.slice(result.matchStart, result.matchEnd)}
                    </mark>
                    {result.snippet.slice(result.matchEnd)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
