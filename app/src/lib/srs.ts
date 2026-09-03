import type { Highlight, ReviewState } from '@/types';

/**
 * 间隔重复调度（SM-2 血统的简化 FSRS）：
 *  - 评分 1 重复 / 2 难 / 3 中 / 4 易（对齐 MarginNote 复习四档）
 *  - 首次学习步进：1→5分钟，2→10分钟，3→1天，4→2天
 *  - 之后按 interval × 系数 增长；评 1 归零重来
 */

const MIN = 60_000;
const DAY = 86_400_000;

export type Rating = 1 | 2 | 3 | 4;

export const RATING_LABEL: Record<Rating, string> = { 1: '重复', 2: '难', 3: '中', 4: '易' };

export function newReviewState(now = Date.now()): ReviewState {
  return { due: now, reps: 0, lapses: 0, interval: 0, addedAt: now };
}

/** 按评分推进复习状态，返回新状态（不改动原对象） */
export function gradeCard(state: ReviewState, rating: Rating, now = Date.now()): ReviewState {
  const s: ReviewState = { ...state, lastRating: rating, lastReviewedAt: now };
  if (rating === 1) {
    s.reps = 0;
    s.lapses = state.lapses + 1;
    s.interval = 0;
    s.due = now + 5 * MIN;
    return s;
  }
  if (s.reps === 0) {
    // 首次通过：按档位进入初始步进
    if (rating === 2) s.due = now + 10 * MIN;
    else if (rating === 3) {
      s.interval = 1;
      s.due = now + 1 * DAY;
    } else {
      s.interval = 2;
      s.due = now + 2 * DAY;
    }
    s.reps = 1;
    return s;
  }
  const factor = rating === 2 ? 1.2 : rating === 3 ? 2.2 : 3.2;
  s.interval = Math.max(1, Math.round(Math.max(s.interval, 1) * factor));
  s.due = now + s.interval * DAY;
  s.reps = state.reps + 1;
  return s;
}

/** 到期队列：已加入复习且到期 */
export function dueCards(highlights: Highlight[], now = Date.now()): Highlight[] {
  return highlights
    .filter((h) => h.review && h.review.due <= now)
    .sort((a, b) => a.review!.due - b.review!.due);
}

/** 在文本中应用挖空遮挡 */
export function applyCloze(text: string, cloze?: string[]): string {
  if (!cloze?.length) return text;
  let out = text;
  for (const c of cloze) {
    if (!c) continue;
    out = out.split(c).join('［＿＿］');
  }
  return out;
}

export function formatDue(due: number, now = Date.now()): string {
  const diff = due - now;
  if (diff <= 0) return '现在到期';
  if (diff < 60 * MIN) return `${Math.ceil(diff / MIN)} 分钟后`;
  if (diff < DAY) return `${Math.ceil(diff / (60 * MIN))} 小时后`;
  return `${Math.round(diff / DAY)} 天后`;
}
