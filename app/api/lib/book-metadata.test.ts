import { describe, expect, it } from "vitest";
import {
  bookMetadataSchema,
  parseStoredBookMetadata,
  serializeBookMetadata,
} from "./book-metadata";

describe("book metadata schema", () => {
  it("round-trips the bounded v1 catalogue record", () => {
    const metadata = {
      version: 1 as const,
      subtitle: "A subtitle",
      contributors: [{ name: "Editor", role: "editor" as const }],
      publisher: "Press",
      publishedDate: "2026-09",
      languages: ["zh-Hans", "en"],
      identifiers: [{ scheme: "ISBN", value: "9780000000001" }],
      subjects: ["history"],
      rating: 4.5,
    };
    expect(parseStoredBookMetadata(serializeBookMetadata(metadata))).toEqual(
      metadata
    );
  });

  it("rejects unknown or unbounded fields and safely reads legacy rows", () => {
    expect(
      bookMetadataSchema.safeParse({ version: 1, unexpected: true }).success
    ).toBe(false);
    expect(
      bookMetadataSchema.safeParse({
        version: 1,
        contributors: Array.from({ length: 65 }, () => ({
          name: "Person",
          role: "author",
        })),
      }).success
    ).toBe(false);
    expect(
      bookMetadataSchema.safeParse({
        version: 1,
        contributors: [
          { name: "A".repeat(200), role: "author" },
          { name: "B".repeat(100), role: "author" },
        ],
      }).success
    ).toBe(false);
    expect(
      bookMetadataSchema.safeParse({
        version: 1,
        description: "书".repeat(20_000),
      }).success
    ).toBe(false);
    expect(
      bookMetadataSchema.safeParse({
        version: 1,
        publishedDate: "2026-02-30",
      }).success
    ).toBe(false);
    expect(parseStoredBookMetadata("{}")).toEqual({ version: 1 });
    expect(parseStoredBookMetadata("not-json")).toEqual({ version: 1 });
  });
});
