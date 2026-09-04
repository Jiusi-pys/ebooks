import { describe, expect, it } from "vitest";
import type { Book } from "@/types";
import {
  bookMetadataDraft,
  normalizeBookMetadataDraft,
  recentBooks,
} from "./bookMetadata";

const baseBook = (id: string, createdAt: number): Book => ({
  id,
  title: `Book ${id}`,
  author: "",
  format: "txt",
  coverTone: 0,
  chapters: [],
  createdAt,
  progress: { chapterId: "", ratio: 0 },
});

describe("book metadata", () => {
  it("normalizes repeatable contributors, identifiers and list fields", () => {
    const result = normalizeBookMetadataDraft({
      ...bookMetadataDraft(baseBook("one", 1)),
      title: "  A Book  ",
      authors: "Alice；Bob",
      translators: "Carol",
      publisher: "Example Press",
      publishedDate: "2026-09",
      languages: "zh-Hans, en-US",
      isbn: "9780000000001",
      otherIdentifiers: "UUID: abc-123",
      subjects: "history, archive",
      series: "Collected Works",
      seriesIndex: "2.5",
      rating: "4.5",
    });

    expect(result).toMatchObject({
      title: "A Book",
      author: "Alice；Bob",
      metadata: {
        publisher: "Example Press",
        publishedDate: "2026-09",
        languages: ["zh-Hans", "en-US"],
        series: "Collected Works",
        seriesIndex: 2.5,
        rating: 4.5,
      },
    });
    expect(result.metadata.contributors).toContainEqual({
      name: "Carol",
      role: "translator",
    });
    expect(result.metadata.identifiers).toContainEqual({
      scheme: "UUID",
      value: "abc-123",
    });
  });

  it("rejects invalid publication dates, language tags and empty titles", () => {
    const draft = bookMetadataDraft(baseBook("one", 1));
    expect(() =>
      normalizeBookMetadataDraft({ ...draft, publishedDate: "2026-02-30" })
    ).toThrow("有效日期");
    expect(() =>
      normalizeBookMetadataDraft({ ...draft, languages: "not a tag" })
    ).toThrow("BCP 47");
    expect(() =>
      normalizeBookMetadataDraft({ ...draft, title: "   " })
    ).toThrow("书名不能为空");
  });

  it("round-trips structured authors and repeated known identifiers", () => {
    const draft = bookMetadataDraft({
      ...baseBook("structured", 1),
      author: "stale legacy author",
      metadata: {
        version: 1,
        contributors: [
          { name: "Canonical Author", role: "author" },
          { name: "Editor", role: "editor" },
        ],
        identifiers: [
          { scheme: "ISBN", value: "first" },
          { scheme: "ISBN", value: "second" },
          { scheme: "DOI", value: "doi-one" },
        ],
      },
    });

    expect(draft.authors).toBe("Canonical Author");
    expect(draft.isbn).toBe("first");
    expect(draft.otherIdentifiers).toContain("ISBN: second");
    expect(normalizeBookMetadataDraft(draft).metadata.identifiers).toEqual([
      { scheme: "ISBN", value: "first" },
      { scheme: "DOI", value: "doi-one" },
      { scheme: "ISBN", value: "second" },
    ]);
  });

  it("rejects author display values that cannot fit the mirror column", () => {
    const draft = bookMetadataDraft(baseBook("authors", 1));
    expect(() =>
      normalizeBookMetadataDraft({
        ...draft,
        authors: `${"A".repeat(200)}；${"B".repeat(100)}`,
      })
    ).toThrow("作者汇总后");
  });
});

describe("recentBooks", () => {
  it("puts opened books first by last-opened time, then unopened imports", () => {
    const oldOpened = { ...baseBook("old-open", 300), lastOpenedAt: 500 };
    const recentOpened = { ...baseBook("recent-open", 100), lastOpenedAt: 900 };
    const neverOpened = baseBook("never-open", 700);
    const olderNeverOpened = baseBook("older-never-open", 600);

    expect(
      recentBooks([oldOpened, recentOpened, neverOpened, olderNeverOpened]).map(
        b => b.id
      )
    ).toEqual(["recent-open", "old-open", "never-open", "older-never-open"]);
  });
});
