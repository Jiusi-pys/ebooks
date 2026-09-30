import type { ReadingSession } from "@/types";
export type { ReadingSession } from "@/types";

function mergedIntervals(sessions: ReadingSession[]) {
  return sessions
    .filter(
      session =>
        Number.isFinite(session.startedAt) &&
        Number.isFinite(session.endedAt) &&
        session.endedAt > session.startedAt
    )
    .map(({ startedAt, endedAt }) => [startedAt, endedAt] as const)
    .sort((a, b) => a[0] - b[0]);
}

function intervalDuration(sessions: ReadingSession[]): number {
  let total = 0;
  let start: number | undefined;
  let end = 0;
  for (const [nextStart, nextEnd] of mergedIntervals(sessions)) {
    if (start === undefined) {
      start = nextStart;
      end = nextEnd;
    } else if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return start === undefined ? total : total + end - start;
}

function uniqueSessions(sessions: ReadingSession[]) {
  return mergeReadingSessions([], sessions);
}

export function mergeReadingSessions(
  current: ReadingSession[] = [],
  incoming: ReadingSession[] = []
): ReadingSession[] {
  const merged = new Map(current.map(session => [session.id, session]));
  for (const session of incoming) {
    const previous = merged.get(session.id);
    if (!previous) merged.set(session.id, session);
    else
      merged.set(session.id, {
        ...previous,
        startedAt: Math.min(previous.startedAt, session.startedAt),
        endedAt: Math.max(previous.endedAt, session.endedAt),
      });
  }
  return [...merged.values()].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)
  );
}

export function readingDurationByBook(sessions: ReadingSession[]) {
  const grouped = new Map<string, ReadingSession[]>();
  for (const session of uniqueSessions(sessions)) {
    const list = grouped.get(session.bookId) ?? [];
    list.push(session);
    grouped.set(session.bookId, list);
  }
  return Object.fromEntries(
    [...grouped].map(([bookId, items]) => [bookId, intervalDuration(items)])
  );
}

export function totalReadingDuration(sessions: ReadingSession[]) {
  return intervalDuration(uniqueSessions(sessions));
}

export function formatReadingDuration(milliseconds: number) {
  const safeMilliseconds = Math.max(0, milliseconds);
  const totalSeconds = Math.floor(safeMilliseconds / 1000);
  if (totalSeconds > 0 && totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}
