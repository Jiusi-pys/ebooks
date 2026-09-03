import { useMemo, useState } from "react";
import {
  CheckSquare,
  GraduationCap,
  Highlighter,
  MessageSquarePlus,
  Quote,
  Search,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import type { Highlight } from "@/types";
import { formatDate } from "@/lib/covers";
import { swatch } from "@/lib/reading";
import { newReviewState } from "@/lib/srs";
import { emitEvent } from "@/lib/events";
import { BatchAction, BatchBar, SelectDot } from "./BatchBar";
import { useSelection } from "@/hooks/useSelection";
import { citationLevelOf } from "@/lib/citations";

type CardType = "all" | "mark" | "note" | "qa";

/** 卡片盒：全部书摘卡片的检索 / 筛选 / 回源 / 加入复习（对齐 MarginNote 卡片盒视图） */
export function HighlightsView({ lib }: { lib: Library }) {
  const [q, setQ] = useState("");
  const [bookFilter, setBookFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [colorFilter, setColorFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<CardType>("all");
  const [reviewFilter, setReviewFilter] = useState<"all" | "in" | "out">("all");
  const sel = useSelection();
  const cardHighlights = useMemo(
    () => lib.highlights.filter(h => citationLevelOf(h) === "content"),
    [lib.highlights]
  );

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const h of cardHighlights) for (const t of h.tags ?? []) s.add(t);
    return [...s].sort();
  }, [cardHighlights]);

  const allColors = useMemo(() => {
    const s = new Set<string>();
    for (const h of cardHighlights) if (h.style) s.add(h.style.color);
    return [...s];
  }, [cardHighlights]);

  const booksWithCards = useMemo(
    () => lib.books.filter(b => cardHighlights.some(h => h.bookId === b.id)),
    [lib.books, cardHighlights]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cardHighlights
      .filter(h => {
        if (bookFilter !== "all" && h.bookId !== bookFilter) return false;
        if (tagFilter && !(h.tags ?? []).includes(tagFilter)) return false;
        if (colorFilter !== "all" && h.style?.color !== colorFilter)
          return false;
        if (typeFilter === "mark" && (h.note || (h.aiQa?.length ?? 0) > 0))
          return false;
        if (typeFilter === "note" && !h.note) return false;
        if (typeFilter === "qa" && (h.aiQa?.length ?? 0) === 0) return false;
        if (reviewFilter === "in" && !h.review) return false;
        if (reviewFilter === "out" && h.review) return false;
        if (needle) {
          const hay =
            `${h.text} ${h.note ?? ""} ${h.name ?? ""} ${(h.tags ?? []).join(" ")}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [
    cardHighlights,
    q,
    bookFilter,
    tagFilter,
    colorFilter,
    typeFilter,
    reviewFilter,
  ]);

  const toggleReview = (h: Highlight) => {
    const next = h.review ? undefined : newReviewState();
    void lib.updateHighlight({ ...h, review: next });
    emitEvent("review.updated", {
      extId: h.id,
      inReview: !h.review,
      due: next?.due,
      review: next,
    });
  };

  /* 批量操作 */
  const selectedCards = filtered.filter(h => sel.selected.has(h.id));

  const batchReview = (join: boolean) => {
    for (const h of selectedCards) {
      if (join && !h.review) {
        const next = newReviewState();
        void lib.updateHighlight({ ...h, review: next });
        emitEvent("review.updated", {
          extId: h.id,
          inReview: true,
          due: next.due,
          review: next,
        });
      } else if (!join && h.review) {
        void lib.updateHighlight({ ...h, review: undefined });
        emitEvent("review.updated", { extId: h.id, inReview: false });
      }
    }
    sel.exit();
  };

  const batchTag = () => {
    const t = window.prompt("为选中卡片添加标签：")?.trim();
    if (!t) return;
    for (const h of selectedCards) {
      const tags = [...new Set([...(h.tags ?? []), t])];
      void lib.updateHighlight({ ...h, tags });
      emitEvent("highlight.tagged", { extId: h.id, tags });
    }
    sel.exit();
  };

  const batchDelete = () => {
    const n = sel.selected.size;
    if (n === 0) return;
    if (confirm(`确定删除选中的 ${n} 张卡片？`)) {
      for (const h of selectedCards) {
        void lib.removeHighlight(h.id);
        emitEvent("highlight.deleted", {
          extId: h.id,
          bookTitle: lib.books.find(b => b.id === h.bookId)?.title ?? "",
        });
      }
      sel.exit();
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        <header className="mb-6 border-b border-foreground/15 pb-6">
          <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            卡片盒 · {filtered.length} / {cardHighlights.length} 条
          </div>
          <h1 className="font-reading mt-2 text-[34px] font-bold tracking-wide">
            卡片盒
          </h1>
          {filtered.length > 0 && !sel.selecting && (
            <button
              onClick={sel.start}
              className="font-meta mt-3 flex items-center gap-1.5 rounded-full border border-foreground/20 px-3 py-1.5 text-[11px] tracking-wider text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <CheckSquare size={12} /> 多选
            </button>
          )}

          {/* 搜索 */}
          <div className="relative mt-4">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="搜索原文、批注、名称、标签…"
              className="h-9 w-full rounded-full border border-border bg-card pl-9 pr-4 text-[13px] outline-none focus:border-primary/60"
            />
          </div>

          {/* 筛选行 */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
            <select
              value={bookFilter}
              onChange={e => setBookFilter(e.target.value)}
              className="h-7 rounded-full border border-border bg-card px-2.5 outline-none"
            >
              <option value="all">全部书籍</option>
              {booksWithCards.map(b => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as CardType)}
              className="h-7 rounded-full border border-border bg-card px-2.5 outline-none"
            >
              <option value="all">全部类型</option>
              <option value="mark">书摘</option>
              <option value="note">批注</option>
              <option value="qa">问答</option>
            </select>
            <select
              value={reviewFilter}
              onChange={e =>
                setReviewFilter(e.target.value as "all" | "in" | "out")
              }
              className="h-7 rounded-full border border-border bg-card px-2.5 outline-none"
            >
              <option value="all">复习：全部</option>
              <option value="in">复习中</option>
              <option value="out">未加入</option>
            </select>
            {allColors.length > 1 && (
              <select
                value={colorFilter}
                onChange={e => setColorFilter(e.target.value)}
                className="h-7 rounded-full border border-border bg-card px-2.5 outline-none"
              >
                <option value="all">全部颜色</option>
                {allColors.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* 标签筛选 */}
          {allTags.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1">
              <Tag size={11} className="text-muted-foreground" />
              {allTags.map(t => (
                <button
                  key={t}
                  onClick={() => setTagFilter(tagFilter === t ? null : t)}
                  className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                    tagFilter === t
                      ? "bg-foreground text-background"
                      : "bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </header>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-muted-foreground">
            <Highlighter size={28} strokeWidth={1.4} />
            <p className="mt-3 text-sm">
              {cardHighlights.length === 0
                ? "阅读时选中文字即可划线，卡片会汇集到这里。"
                : "没有符合筛选条件的卡片。"}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filtered.map(h => {
              const style = h.style ?? {
                kind: "underline" as const,
                color: "orange",
              };
              const c = swatch(style.color);
              const book = lib.books.find(b => b.id === h.bookId);
              const checked = sel.selected.has(h.id);
              return (
                <div
                  key={h.id}
                  onClick={sel.selecting ? () => sel.toggle(h.id) : undefined}
                  className={`rounded-md bg-card p-4 shadow-sm ${h.noteId ? "border-l-[3px] border-primary" : ""} ${sel.selecting ? "cursor-pointer select-none" : ""} ${
                    checked
                      ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
                      : ""
                  }`}
                >
                  {sel.selecting && (
                    <div className="mb-1.5">
                      <SelectDot checked={checked} />
                    </div>
                  )}
                  <div className="mb-1.5 flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-6 rounded-sm"
                      style={{
                        background:
                          style.kind === "underline"
                            ? `linear-gradient(transparent 60%, ${c.solid} 60%)`
                            : style.kind === "background"
                              ? c.soft
                              : style.kind === "color"
                                ? c.solid
                                : "transparent",
                      }}
                    />
                    {h.noteId && (
                      <span className="font-meta inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[10px] text-primary">
                        <Quote size={10} /> 引用
                      </span>
                    )}
                    {h.name && (
                      <span className="font-meta ml-1 text-[10.5px] uppercase tracking-wider text-primary">
                        {h.name}
                      </span>
                    )}
                    {h.review && (
                      <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                        复习中
                      </span>
                    )}
                  </div>
                  <p className="font-reading text-[14px] leading-7">{h.text}</p>
                  {h.note && (
                    <p className="mt-2 flex gap-1.5 rounded-md bg-accent/40 p-2.5 text-[12.5px] leading-6">
                      <MessageSquarePlus
                        size={13}
                        className="mt-1 shrink-0 text-primary"
                      />
                      {h.note}
                    </p>
                  )}
                  {(h.tags?.length ?? 0) > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {h.tags!.map(t => (
                        <button
                          key={t}
                          onClick={() => setTagFilter(t)}
                          className="rounded-full bg-secondary px-1.5 py-px text-[10.5px] text-muted-foreground hover:text-foreground"
                        >
                          # {t}
                        </button>
                      ))}
                    </div>
                  )}
                  {(h.aiQa?.length ?? 0) > 0 && (
                    <div className="font-meta mt-2 flex items-center gap-1.5 text-[10.5px] text-primary">
                      <Sparkles size={11} /> {h.aiQa!.length} 条 AI 问答 ·
                      最近：{h.aiQa![h.aiQa!.length - 1].q}
                    </div>
                  )}
                  <div className="font-meta mt-2 flex items-center justify-between text-[10.5px] text-muted-foreground">
                    <span className="truncate">
                      {book && `《${book.title}》 · `}
                      {h.chapterTitle} · {formatDate(h.createdAt)}
                    </span>
                    {!sel.selecting && (
                      <span className="flex shrink-0 gap-3">
                        <button
                          className="hover:text-primary"
                          onClick={() =>
                            lib.navigate({
                              view: "reader",
                              bookId: h.bookId,
                              chapterId: h.chapterId,
                              highlightId: h.id,
                            })
                          }
                        >
                          回到原文
                        </button>
                        <button
                          className={
                            h.review
                              ? "text-primary hover:underline"
                              : "hover:text-primary"
                          }
                          onClick={() => toggleReview(h)}
                        >
                          {h.review ? "移出复习" : "加入复习"}
                        </button>
                        {h.noteId && (
                          <>
                            <button
                              className="text-primary hover:underline"
                              onClick={() =>
                                lib.navigate({ view: "note", noteId: h.noteId })
                              }
                            >
                              查看引用笔记
                            </button>
                            <button
                              className="hover:text-destructive"
                              onClick={() => void lib.unlinkCitation(h.id)}
                            >
                              取消引用
                            </button>
                          </>
                        )}
                        <button
                          className="hover:text-destructive"
                          onClick={() => lib.removeHighlight(h.id)}
                        >
                          删除
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 批量操作条 */}
      {sel.selecting && (
        <BatchBar
          count={sel.selected.size}
          total={filtered.length}
          onSelectAll={() => sel.selectAll(filtered.map(h => h.id))}
          onExit={sel.exit}
        >
          <BatchAction
            disabled={sel.selected.size === 0}
            onClick={() => batchReview(true)}
          >
            <GraduationCap size={13} /> 加入复习
          </BatchAction>
          <BatchAction
            disabled={sel.selected.size === 0}
            onClick={() => batchReview(false)}
          >
            移出复习
          </BatchAction>
          <BatchAction disabled={sel.selected.size === 0} onClick={batchTag}>
            <Tag size={13} /> 加标签
          </BatchAction>
          <BatchAction
            disabled={sel.selected.size === 0}
            danger
            onClick={batchDelete}
          >
            <Trash2 size={13} /> 删除
          </BatchAction>
        </BatchBar>
      )}
    </div>
  );
}
