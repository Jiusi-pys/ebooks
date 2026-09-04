import { describe, expect, it } from "vitest";
import { importedBookMetadata, normalizeImportedDate } from "./importMetadata";
import { MAX_BOOK_METADATA_BYTES } from "./bookMetadata";

describe("importedBookMetadata", () => {
  it("normalizes embedded catalogue values and drops malformed optional data", () => {
    expect(
      importedBookMetadata({
        subtitle: "  A subtitle  ",
        contributors: [
          { name: "Alice", role: "author" },
          { name: "Alice", role: "author" },
          { name: "Bob", role: "translator" },
        ],
        publishers: ["Example Press", "Example Press"],
        publishedDates: ["not-a-date", "2024-02-29T12:00:00Z"],
        languages: ["en_us", "bad language", "zh-Hans"],
        identifiers: [
          { value: "urn:isbn:978-1-4028-9462-6" },
          { scheme: "doi", value: "https://doi.org/10.1000/example" },
        ],
        subjects: ["History", "history"],
        descriptions: [" Summary "],
        rights: ["Copyright holder"],
      })
    ).toEqual({
      version: 1,
      subtitle: "A subtitle",
      contributors: [
        { name: "Alice", role: "author" },
        { name: "Bob", role: "translator" },
      ],
      publisher: "Example Press",
      publishedDate: "2024-02-29",
      languages: ["en-US", "zh-Hans"],
      identifiers: [
        { scheme: "ISBN", value: "978-1-4028-9462-6" },
        { scheme: "DOI", value: "10.1000/example" },
      ],
      subjects: ["History"],
      description: "Summary",
      rights: "Copyright holder",
    });
  });

  it("returns undefined when the source has no usable extended metadata", () => {
    expect(importedBookMetadata({ languages: ["not a tag"] })).toBeUndefined();
  });

  it("keeps untrusted Unicode metadata within the MySQL byte budget", () => {
    const metadata = importedBookMetadata({
      contributors: Array.from({ length: 32 }, (_, index) => ({
        name: `${index}-${"作".repeat(250)}`,
        role: "author" as const,
      })),
      identifiers: Array.from({ length: 32 }, (_, index) => ({
        scheme: "UUID",
        value: `${index}-${"标".repeat(250)}`,
      })),
      descriptions: ["📚".repeat(20_000)],
      rights: ["权".repeat(2_000)],
    });

    expect(metadata).toBeDefined();
    expect(
      new TextEncoder().encode(JSON.stringify(metadata)).byteLength
    ).toBeLessThanOrEqual(MAX_BOOK_METADATA_BYTES);
    expect(
      metadata?.contributors
        ?.filter(contributor => contributor.role === "author")
        .map(contributor => contributor.name)
        .join("；").length
    ).toBeLessThanOrEqual(255);
  });
});

describe("normalizeImportedDate", () => {
  it.each([
    ["2026", "2026"],
    ["2026-09", "2026-09"],
    ["2024-02-29T08:00:00Z", "2024-02-29"],
    ["2026-02-30", undefined],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeImportedDate(input)).toBe(expected);
  });
});
