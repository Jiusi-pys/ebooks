import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CornerLeftUp,
  Eye,
  Link2,
  Quote,
  Trash2,
  Unlink,
} from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import type { Note } from "@/types";
import { computeBacklinks, extractLinks } from "@/lib/links";
import { MarkdownLite } from "./MarkdownLite";
import { formatDate } from "@/lib/covers";
import {
  citationDescriptorForHighlight,
  citationLevelOf,
  removeCitationBlock,
} from "@/lib/citations";

interface Suggestion {
  label: string;
  kind: "book" | "note" | "new";
}

export function NoteEditor({ lib, note }: { lib: Library; note: Note }) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [preview, setPreview] = useState(false);
  const [sug, setSug] = useState<{
    query: string;
    items: Suggestion[];
    active: number;
  } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<number | null>(null);
  const dirty = useRef(false);

  const existingTitles = useMemo(() => {
    const s = new Set<string>();
    lib.books.forEach(b => s.add(b.title.toLowerCase()));
    lib.notes.forEach(n => s.add(n.title.toLowerCase()));
    return s;
  }, [lib.books, lib.notes]);

  const openByTitle = lib.openByTitle;

  // 自动保存（防抖）
  const persist = useCallback(
    (t: string, c: string) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        lib.saveNote({ ...note, title: t.trim() || "未命名笔记", content: c });
        dirty.current = false;
      }, 700);
    },
    [lib, note]
  );

  useEffect(() => {
    setTitle(note.title);
    setContent(note.content);
    dirty.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (dirty.current)
        lib.saveNote({ ...note, title: title.trim() || "未命名笔记", content });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id]
  );

  /** 检测光标前的 [[ 触发联想 */
  const updateSuggest = useCallback(
    (value: string, caret: number) => {
      const before = value.slice(0, caret);
      const m = /\[\[([^\]\n]{0,40})$/.exec(before);
      if (!m) {
        setSug(null);
        return;
      }
      const q = m[1].trim().toLowerCase();
      const pool: Suggestion[] = [
        ...lib.books.map(b => ({ label: b.title, kind: "book" as const })),
        ...lib.notes
          .filter(n => n.id !== note.id)
          .map(n => ({ label: n.title, kind: "note" as const })),
      ];
      const items = pool
        .filter(p => !q || p.label.toLowerCase().includes(q))
        .slice(0, 7);
      if (q && !items.some(i => i.label.toLowerCase() === q))
        items.push({ label: m[1].trim(), kind: "new" });
      if (items.length === 0) {
        setSug(null);
        return;
      }
      setSug({ query: m[1], items, active: 0 });
    },
    [lib.books, lib.notes, note.id]
  );

  const applySuggestion = useCallback(
    (item: Suggestion) => {
      const ta = taRef.current;
      if (!ta || !sug) return;
      const caret = ta.selectionStart;
      const before = content
        .slice(0, caret)
        .replace(/\[\[[^\]\n]{0,40}$/, `[[${item.label}]]`);
      const next = before + content.slice(caret);
      setContent(next);
      persist(title, next);
      setSug(null);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = before.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [content, persist, sug, title]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sug) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSug(s => s && { ...s, active: (s.active + 1) % s.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSug(
          s =>
            s && {
              ...s,
              active: (s.active - 1 + s.items.length) % s.items.length,
            }
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySuggestion(sug.items[sug.active]);
        return;
      }
      if (e.key === "Escape") {
        setSug(null);
        return;
      }
    }
  };

  const backlinks = useMemo(
    () => computeBacklinks(title, lib.notes, note.id),
    [title, lib.notes, note.id]
  );
  const linkedHighlights = useMemo(
    () => lib.highlights.filter(h => h.noteId === note.id),
    [lib.highlights, note.id]
  );
  const outLinks = useMemo(() => extractLinks(content), [content]);

  const unlinkHighlightCitation = async (
    highlight: (typeof linkedHighlights)[number]
  ) => {
    const book = lib.books.find(item => item.id === highlight.bookId);
    const latestNote = {
      ...note,
      title: title.trim() || "未命名笔记",
      content,
    };
    const nextContent = book
      ? removeCitationBlock(
          content,
          citationDescriptorForHighlight(highlight, book.title)
        )
      : content;

    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    dirty.current = false;
    setContent(nextContent);
    await lib.unlinkCitation(highlight.id, {
      ...latestNote,
      content: nextContent,
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <button
          onClick={() => lib.navigate({ view: "notes" })}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <ArrowLeft size={15} /> 笔记
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setPreview(v => !v)}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors ${
            preview
              ? "border-primary bg-accent/50 text-foreground"
              : "border-border text-muted-foreground hover:bg-card"
          }`}
        >
          <Eye size={13} /> {preview ? "继续编辑" : "预览"}
        </button>
        <button
          onClick={() => {
            if (confirm(`确定删除笔记「${title}」？`)) lib.removeNote(note.id);
          }}
          className="rounded-md p-1.5 text-muted-foreground hover:text-destructive"
          title="删除笔记"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-8 pb-24 pt-10">
          {/* 标题 */}
          <input
            value={title}
            onChange={e => {
              setTitle(e.target.value);
              dirty.current = true;
              persist(e.target.value, content);
            }}
            placeholder="未命名笔记"
            className="font-reading w-full border-none bg-transparent text-[32px] font-bold tracking-wide outline-none placeholder:text-muted-foreground/40"
          />
          <div className="font-meta mt-2 text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/70">
            更新于 {formatDate(note.updatedAt)} · {content.length} 字 ·
            提示：输入 [[ 联想书名或笔记名
          </div>

          {/* 出链 chips */}
          {outLinks.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              <Link2 size={12} className="text-muted-foreground" />
              {outLinks.map(l => (
                <button
                  key={l}
                  onClick={() => openByTitle(l)}
                  className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  {l}
                </button>
              ))}
            </div>
          )}

          {/* 编辑 / 预览 */}
          {preview ? (
            <div className="mt-6">
              {content.trim() ? (
                <MarkdownLite
                  content={content}
                  existingTitles={existingTitles}
                  onOpenTitle={openByTitle}
                />
              ) : (
                <p className="text-sm text-muted-foreground">还没有内容。</p>
              )}
            </div>
          ) : (
            <div className="relative mt-6">
              <textarea
                ref={taRef}
                value={content}
                onChange={e => {
                  setContent(e.target.value);
                  dirty.current = true;
                  persist(title, e.target.value);
                  updateSuggest(e.target.value, e.target.selectionStart);
                }}
                onKeyDown={onKeyDown}
                onClick={e =>
                  updateSuggest(content, e.currentTarget.selectionStart)
                }
                placeholder={
                  "开始书写……\n\n支持 # 标题、> 引用、- 列表、**粗体**，以及 [[双链]] 关联书籍与笔记。"
                }
                className="min-h-[420px] w-full resize-y rounded-md border border-border bg-card p-5 text-[15px] leading-8 outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/60"
              />
              {/* [[ 联想面板 */}
              {sug && (
                <div className="absolute left-4 top-2 z-20 w-64 rounded-md border border-border bg-popover py-1 shadow-xl">
                  <div className="font-meta px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                    链接到…
                  </div>
                  {sug.items.map((item, i) => (
                    <button
                      key={`${item.kind}-${item.label}`}
                      onMouseDown={e => {
                        e.preventDefault();
                        applySuggestion(item);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
                        i === sug.active ? "bg-sidebar-accent" : ""
                      }`}
                    >
                      <span
                        className={`font-meta shrink-0 rounded px-1 text-[9.5px] uppercase ${
                          item.kind === "book"
                            ? "bg-primary/10 text-primary"
                            : item.kind === "note"
                              ? "bg-foreground/10 text-muted-foreground"
                              : "bg-accent text-accent-foreground"
                        }`}
                      >
                        {item.kind === "book"
                          ? "书"
                          : item.kind === "note"
                            ? "笔记"
                            : "新建"}
                      </span>
                      <span className="truncate">{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 书籍 / 章节 / 内容分级引用 */}
          {linkedHighlights.length > 0 && (
            <section className="mt-12">
              <h3 className="font-meta flex items-center gap-2 text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
                <Quote size={12} /> 分级引用 · {linkedHighlights.length}
              </h3>
              <div className="mt-3 space-y-2.5">
                {linkedHighlights.map(h => {
                  const b = lib.books.find(x => x.id === h.bookId);
                  const level = citationLevelOf(h);
                  const levelLabel =
                    level === "book"
                      ? "书籍"
                      : level === "chapter"
                        ? "章节"
                        : "具体内容";
                  return (
                    <div
                      key={h.id}
                      className="flex items-start rounded-md border-l-[3px] border-primary bg-card transition-shadow hover:shadow-md"
                    >
                      <button
                        onClick={() => {
                          if (!b) return;
                          if (level === "book") {
                            lib.openReader(b.id);
                            return;
                          }
                          lib.navigate({
                            view: "reader",
                            bookId: b.id,
                            chapterId: h.chapterId,
                            highlightId: level === "content" ? h.id : undefined,
                          });
                        }}
                        className="min-w-0 flex-1 p-3.5 text-left"
                      >
                        <div className="font-meta mb-1.5 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                          {levelLabel}引用
                        </div>
                        <p className="font-reading text-[13.5px] leading-7">
                          {level === "book"
                            ? `《${b?.title ?? "未知书籍"}》`
                            : level === "chapter"
                              ? h.chapterTitle
                              : h.text}
                        </p>
                        {h.note && (
                          <p className="mt-1.5 text-[12.5px] leading-6 text-muted-foreground">
                            批注：{h.note}
                          </p>
                        )}
                        <div className="font-meta mt-1.5 text-[10.5px] text-muted-foreground">
                          《{b?.title ?? "未知书籍"}》
                          {level !== "book" && ` → ${h.chapterTitle}`}
                          {level === "content" && " → 具体内容"} · 点击跳转
                        </div>
                      </button>
                      <button
                        type="button"
                        title="取消引用"
                        aria-label={`取消引用：${h.text.slice(0, 24)}`}
                        onClick={() => void unlinkHighlightCitation(h)}
                        className="m-2 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Unlink size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 反链面板 */}
          <section className="mt-12 border-t border-border pt-8">
            <h3 className="font-meta flex items-center gap-2 text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
              <CornerLeftUp size={12} /> 被引用 · Backlinks · {backlinks.length}
            </h3>
            {backlinks.length === 0 ? (
              <p className="mt-3 text-[13px] leading-7 text-muted-foreground">
                还没有其他笔记链接到这里。在别的笔记里输入{" "}
                <span className="wikilink">[[{title}]]</span> 即可建立回链。
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {backlinks.map(b => (
                  <button
                    key={b.noteId}
                    onClick={() =>
                      lib.navigate({ view: "note", noteId: b.noteId })
                    }
                    className="block w-full rounded-md bg-card p-3.5 text-left transition-shadow hover:shadow-md"
                  >
                    <div className="text-[13.5px] font-medium">
                      {b.noteTitle}
                    </div>
                    <div className="mt-1 truncate text-[12.5px] text-muted-foreground">
                      …{b.excerpt}…
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
