import { useMemo, useState } from "react";
import { BookOpen, CheckCircle2, GraduationCap, RotateCcw } from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import type { Highlight } from "@/types";
import {
  applyCloze,
  dueCards,
  formatDue,
  gradeCard,
  RATING_LABEL,
  type Rating,
} from "@/lib/srs";
import { emitEvent } from "@/lib/events";
import { citationLevelOf } from "@/lib/citations";

const RATING_STYLE: Record<Rating, string> = {
  1: "bg-destructive/10 text-destructive hover:bg-destructive/20",
  2: "bg-[#b45309]/10 text-[#b45309] hover:bg-[#b45309]/20",
  3: "bg-primary/10 text-primary hover:bg-primary/20",
  4: "bg-emerald-700/10 text-emerald-700 hover:bg-emerald-700/20",
};

/** 复习视图：卡组（按书）+ 闪卡会话 + 四档评分 + 回源（对齐 MarginNote 复习模式） */
export function ReviewView({ lib }: { lib: Library }) {
  const [deck, setDeck] = useState<string>("all");
  const [queue, setQueue] = useState<string[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [doneCount, setDoneCount] = useState(0);

  /** 从学习集进入时，只复习该独立学习集所选书籍的卡片。 */
  const studySetFilter = useMemo(() => {
    const sid = lib.route.studySetId;
    if (!sid) return null;
    const studySet = lib.studySets.find(set => set.id === sid);
    return studySet ? new Set(studySet.bookIds) : null;
  }, [lib.route.studySetId, lib.studySets]);
  const studySetName = studySetFilter
    ? lib.studySets.find(set => set.id === lib.route.studySetId)?.name
    : null;

  const reviewCards = useMemo(
    () =>
      lib.highlights.filter(
        h =>
          citationLevelOf(h) === "content" &&
          h.review &&
          (!studySetFilter || studySetFilter.has(h.bookId))
      ),
    [lib.highlights, studySetFilter]
  );
  const deckCards =
    deck === "all" ? reviewCards : reviewCards.filter(h => h.bookId === deck);
  const due = dueCards(deckCards);
  const upcoming = deckCards
    .filter(h => h.review && h.review.due > Date.now())
    .sort((a, b) => a.review!.due - b.review!.due);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayReviewed = reviewCards.filter(
    h =>
      h.review?.lastReviewedAt &&
      h.review.lastReviewedAt >= todayStart.getTime()
  ).length;

  /** 有复习卡片的书 → 卡组（学习集内则只看该集明确选择的书） */
  const decks = lib.books
    .filter(b => !studySetFilter || studySetFilter.has(b.id))
    .map(b => ({
      book: b,
      count: reviewCards.filter(h => h.bookId === b.id).length,
    }))
    .filter(d => d.count > 0);

  const current: Highlight | null =
    queue && idx < queue.length
      ? (lib.highlights.find(h => h.id === queue[idx]) ?? null)
      : null;

  const startSession = () => {
    setQueue(due.map(h => h.id));
    setIdx(0);
    setFlipped(false);
    setDoneCount(0);
  };

  const rate = (card: Highlight, rating: Rating) => {
    const next = gradeCard(card.review!, rating);
    void lib.updateHighlight({ ...card, review: next });
    emitEvent("review.updated", {
      extId: card.id,
      rating,
      due: next.due,
      reps: next.reps,
      lapses: next.lapses,
    });
    setDoneCount(n => n + 1);
    setIdx(i => i + 1);
    setFlipped(false);
  };

  const backToSource = (card: Highlight) =>
    lib.navigate({
      view: "reader",
      bookId: card.bookId,
      chapterId: card.chapterId,
      highlightId: card.id,
    });

  const deckName =
    deck === "all"
      ? "全部卡组"
      : `《${lib.books.find(b => b.id === deck)?.title ?? ""}》`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        <header className="mb-8 border-b border-foreground/15 pb-6">
          <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            复习 · {reviewCards.length} 张卡片 · 今日已复习 {todayReviewed}
          </div>
          <h1 className="font-reading mt-2 text-[34px] font-bold tracking-wide">
            复习
            {studySetName && (
              <span className="ml-3 text-[16px] font-medium text-primary">
                学习集 · {studySetName}
              </span>
            )}
          </h1>
          {/* 卡组选择 */}
          <div className="mt-4 flex flex-wrap gap-1.5">
            <DeckButton
              active={deck === "all"}
              onClick={() => {
                setDeck("all");
                setQueue(null);
              }}
              label={`全部 ${reviewCards.length}`}
            />
            {decks.map(({ book, count }) => (
              <DeckButton
                key={book.id}
                active={deck === book.id}
                onClick={() => {
                  setDeck(book.id);
                  setQueue(null);
                }}
                label={`${book.title} ${count}`}
              />
            ))}
          </div>
        </header>

        {reviewCards.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-muted-foreground">
            <GraduationCap size={28} strokeWidth={1.4} />
            <p className="mt-3 text-sm">
              还没有复习卡片。在书摘弹层或卡片盒里点「加入复习」，把摘录变成闪卡。
            </p>
          </div>
        ) : queue === null ? (
          /* 卡组落地页 */
          <div>
            <div className="flex items-center justify-between rounded-lg bg-card p-5 shadow-sm">
              <div>
                <div className="font-reading text-[20px] font-semibold">
                  {deckName}
                </div>
                <div className="font-meta mt-1 text-[11px] text-muted-foreground">
                  {due.length > 0 ? `${due.length} 张已到期` : "没有到期卡片"}
                  {upcoming.length > 0 &&
                    ` · 下一张 ${formatDue(upcoming[0].review!.due)}`}
                </div>
              </div>
              <button
                onClick={startSession}
                disabled={due.length === 0}
                className="rounded-full bg-primary px-5 py-2 text-[13px] font-medium text-primary-foreground disabled:opacity-40"
              >
                开始复习
              </button>
            </div>

            {upcoming.length > 0 && (
              <div className="mt-8">
                <div className="font-meta mb-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
                  即将到来 · {upcoming.length}
                </div>
                <div className="space-y-2">
                  {upcoming.slice(0, 12).map(h => (
                    <button
                      key={h.id}
                      onClick={() => backToSource(h)}
                      className="flex w-full items-center gap-3 rounded-md bg-card p-3 text-left shadow-sm hover:opacity-80"
                    >
                      <span className="font-meta w-16 shrink-0 text-[10.5px] text-primary">
                        {formatDue(h.review!.due)}
                      </span>
                      <span className="font-reading flex-1 truncate text-[13px]">
                        {h.text}
                      </span>
                      <span className="font-meta shrink-0 text-[10px] text-muted-foreground">
                        {h.chapterTitle}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : !current ? (
          /* 会话完成 */
          <div className="flex flex-col items-center py-20">
            <CheckCircle2
              size={30}
              strokeWidth={1.4}
              className="text-primary"
            />
            <p className="font-reading mt-4 text-[20px] font-semibold">
              本会话完成
            </p>
            <p className="font-meta mt-1 text-[12px] text-muted-foreground">
              已复习 {doneCount} 张 · {deckName}
            </p>
            <button
              onClick={() => setQueue(null)}
              className="mt-6 flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-[12.5px] hover:bg-secondary"
            >
              <RotateCcw size={12} /> 返回卡组
            </button>
          </div>
        ) : (
          /* 闪卡会话 */
          <div>
            <div className="font-meta mb-4 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {deckName} · {idx + 1} / {queue.length}
              </span>
              <button
                onClick={() => setQueue(null)}
                className="hover:text-foreground"
              >
                结束会话
              </button>
            </div>

            <div className="rounded-lg bg-card p-8 shadow-sm">
              <div className="font-meta mb-3 flex items-center gap-2 text-[10.5px] text-muted-foreground">
                <BookOpen size={11} />
                {lib.books.find(b => b.id === current.bookId)?.title} ·{" "}
                {current.chapterTitle}
                {(current.cloze?.length ?? 0) > 0 && (
                  <span className="text-primary">
                    · {current.cloze!.length} 处挖空
                  </span>
                )}
              </div>
              <p className="font-reading min-h-24 text-[17px] leading-8">
                {flipped
                  ? current.text
                  : applyCloze(current.text, current.cloze)}
              </p>
              {flipped && current.note && (
                <p className="mt-4 rounded-md bg-accent/40 p-3 text-[13.5px] leading-6">
                  {current.note}
                </p>
              )}
              {flipped && (
                <button
                  onClick={() => backToSource(current)}
                  className="font-meta mt-4 text-[11.5px] text-primary hover:underline"
                >
                  回到原文 →
                </button>
              )}
            </div>

            {!flipped ? (
              <button
                onClick={() => setFlipped(true)}
                className="mt-5 w-full rounded-full border border-border py-2.5 text-[13px] hover:bg-secondary"
              >
                显示答案
              </button>
            ) : (
              <div className="mt-5 grid grid-cols-4 gap-2">
                {([1, 2, 3, 4] as Rating[]).map(r => (
                  <button
                    key={r}
                    onClick={() => rate(current, r)}
                    className={`rounded-full py-2.5 text-[13px] font-medium transition-colors ${RATING_STYLE[r]}`}
                  >
                    {RATING_LABEL[r]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DeckButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
        active
          ? "bg-foreground text-background"
          : "bg-secondary text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
