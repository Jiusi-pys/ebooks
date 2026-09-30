import { describe, expect, it } from "vitest";
import {
  formatReadingDuration,
  mergeReadingSessions,
  readingDurationByBook,
  totalReadingDuration,
  type ReadingSession,
} from "./readingTime";

const session = (
  id: string,
  bookId: string,
  startedAt: number,
  endedAt: number
): ReadingSession => ({ id, bookId, startedAt, endedAt });

describe("reading time aggregation", () => {
  it("deduplicates replayed session IDs and merges newer checkpoints", () => {
    const first = session("same", "book-a", 100, 200);
    expect(
      mergeReadingSessions(
        [first],
        [first, session("same", "book-a", 100, 250)]
      )
    ).toEqual([session("same", "book-a", 100, 250)]);
  });

  it("counts overlapping device intervals once per book and globally", () => {
    const sessions = [
      session("a", "book-a", 0, 10_000),
      session("b", "book-a", 5_000, 15_000),
      session("c", "book-b", 12_000, 20_000),
    ];

    expect(readingDurationByBook(sessions)).toEqual({
      "book-a": 15_000,
      "book-b": 8_000,
    });
    expect(totalReadingDuration(sessions)).toBe(20_000);
  });

  it("ignores invalid and zero-length intervals", () => {
    expect(
      totalReadingDuration([
        session("zero", "book", 10, 10),
        session("negative", "book", 20, 10),
      ])
    ).toBe(0);
  });

  it("formats short sessions without rounding them down to zero minutes", () => {
    expect(formatReadingDuration(15_000)).toBe("15 秒");
  });
});
