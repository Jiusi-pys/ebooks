import { describe, expect, it } from "vitest";
import {
  readerStateSchema,
  restoreBook,
  validateSourceChunks,
} from "./library-state";
import { createHash } from "node:crypto";

describe("server library restoration", () => {
  it("restores progress, cover, outline and chapters from persisted data", () => {
    const state = {
      coverTone: 2,
      cover: "data:image/png;base64,AA==",
      createdAt: 123,
      progress: { chapterId: "c", ratio: 0.5 },
      outline: [{ id: "o", title: "目录", chapterId: "c", depth: 0 }],
    };
    const book = restoreBook({
      extId: "b",
      title: "Book",
      author: "Author",
      format: "epub",
      folder: "",
      contentHash: "hash",
      metadata: null,
      readerData: JSON.stringify(state),
      chapters: '[{"id":"c","title":"Chapter","paragraphs":["text"]}]',
      createdAt: new Date(123),
    });
    expect(book).toMatchObject({ id: "b", ...state, chapters: [{ id: "c" }] });
  });
  it("upgrades legacy mirrors without reader state", () => {
    expect(
      restoreBook({
        extId: "b",
        title: "Book",
        author: "",
        format: "txt",
        folder: "",
        contentHash: "",
        metadata: null,
        readerData: null,
        chapters: "[]",
        createdAt: new Date(123),
      })
    ).toMatchObject({
      id: "b",
      createdAt: 123,
      progress: { chapterId: "", ratio: 0 },
    });
  });

  it("accepts a complete book-specific typesetting override", () => {
    expect(
      readerStateSchema.safeParse({
        typeSettings: {
          fontId: "kai",
          fontSize: 22,
          lineHeight: 2,
          paragraphSpacing: 0.4,
          letterSpacing: 0.02,
          pageMargin: 32,
          fontWeight: 400,
          columns: 1,
          pageTurnMode: "vertical",
          themeId: "warm",
        },
      }).success
    ).toBe(true);
    expect(readerStateSchema.safeParse({ typeSettings: null }).success).toBe(
      true
    );
  });
  it("rejects invalid progress and executable cover URLs", () => {
    expect(
      readerStateSchema.safeParse({ progress: { chapterId: "c", ratio: 2 } })
        .success
    ).toBe(false);
    expect(
      readerStateSchema.safeParse({ cover: "javascript:alert(1)" }).success
    ).toBe(false);
  });
  it("checks complete ordered source chunks, exact size and hash", () => {
    const bytes = Buffer.from("%PDF-1.7\nsource");
    const source = {
      size: bytes.length,
      chunks: 2,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const chunks = [
      { chunkIndex: 0, payload: bytes.subarray(0, 5).toString("base64") },
      { chunkIndex: 1, payload: bytes.subarray(5).toString("base64") },
    ];
    expect(validateSourceChunks(source, chunks)).toEqual(bytes);
    expect(() => validateSourceChunks(source, chunks.slice(1))).toThrow();
    expect(() =>
      validateSourceChunks({ ...source, size: 1 }, chunks)
    ).toThrow();
    expect(() =>
      validateSourceChunks({ ...source, sha256: "0".repeat(64) }, chunks)
    ).toThrow();
  });
});
