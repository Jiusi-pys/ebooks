import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, or } from "drizzle-orm";

import { bookDigests } from "@db/schema";
import {
  mirrorAssociations,
  mirrorBooks,
  mirrorBookTombstones,
  mirrorBookUploadChunks,
  mirrorHighlights,
  mirrorMindmaps,
  mirrorNoteTombstones,
  mirrorNotes,
  mirrorTranslations,
} from "@db/mirror-schema";
import { associationPairKey, type PassageAnchor } from "./lib/association";
import { saveDigestIfReferenced } from "./lib/book-digest-lifecycle";
import { getDb } from "./queries/connection";
import { v1 } from "./v1";

const runMysql = process.env.RUN_MYSQL_INTEGRATION === "1";
const suite = describe.skipIf(!runMysql);
const prefix = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ids = {
  bookA: `${prefix}-a`,
  bookB: `${prefix}-b`,
  bookC: `${prefix}-c`,
  bookD: `${prefix}-d`,
  partialBook: `${prefix}-partial`,
  absentBook: `${prefix}-absent`,
  queuedBook: `${prefix}-queued`,
  digestBook: `${prefix}-digest`,
  note: `${prefix}-note`,
  deletedNote: `${prefix}-deleted-note`,
  highlight: `${prefix}-hl`,
  translation: `${prefix}-tr`,
  mindmap: `${prefix}-mm`,
  association: `${prefix}-assoc`,
};
const allBooks = [
  ids.bookA,
  ids.bookB,
  ids.bookC,
  ids.bookD,
  ids.partialBook,
  ids.absentBook,
  ids.queuedBook,
  ids.digestBook,
];
const sharedHash = "a".repeat(64);
const concurrentHash = "b".repeat(64);
const stagedHash = "c".repeat(64);
const raceHash = "d".repeat(64);

function apiRequest(path: string, method = "GET", body?: unknown) {
  const apiKey = process.env.OPEN_API_KEY;
  if (!apiKey)
    throw new Error("OPEN_API_KEY is required for MySQL integration tests");
  return v1.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function bookBody(extId: string, title: string, contentHash: string) {
  return {
    extId,
    title,
    author: "Alice",
    metadata: {
      version: 1 as const,
      contributors: [{ name: "Alice", role: "author" as const }],
      publisher: "Metadata Press",
    },
    format: "txt",
    folder: "",
    contentHash,
    chapters: [{ id: "chapter-1", title: "Chapter", paragraphs: ["quoted"] }],
  };
}

async function cleanup() {
  const database = getDb();
  await database
    .delete(mirrorAssociations)
    .where(
      or(
        inArray(mirrorAssociations.sourceBookExtId, allBooks),
        inArray(mirrorAssociations.targetBookExtId, allBooks)
      )
    );
  await database
    .delete(mirrorBookUploadChunks)
    .where(inArray(mirrorBookUploadChunks.bookExtId, allBooks));
  await database
    .delete(mirrorHighlights)
    .where(inArray(mirrorHighlights.bookExtId, allBooks));
  await database
    .delete(mirrorTranslations)
    .where(inArray(mirrorTranslations.bookExtId, allBooks));
  await database
    .delete(mirrorMindmaps)
    .where(inArray(mirrorMindmaps.bookExtId, allBooks));
  await database
    .delete(mirrorBooks)
    .where(inArray(mirrorBooks.extId, allBooks));
  await database
    .delete(mirrorBookTombstones)
    .where(inArray(mirrorBookTombstones.extId, allBooks));
  await database
    .delete(mirrorNotes)
    .where(inArray(mirrorNotes.extId, [ids.note, ids.deletedNote]));
  await database
    .delete(mirrorNoteTombstones)
    .where(inArray(mirrorNoteTombstones.extId, [ids.note, ids.deletedNote]));
  await database
    .delete(bookDigests)
    .where(
      inArray(bookDigests.contentHash, [
        sharedHash,
        concurrentHash,
        stagedHash,
        raceHash,
      ])
    );
}

suite("v1 real MySQL deletion invariants", () => {
  afterAll(cleanup);

  it("derives child titles from the locked book and synchronizes direct reimports", async () => {
    await cleanup();
    expect(
      (
        await apiRequest(
          "/books",
          "POST",
          bookBody(ids.bookA, "Original", sharedHash)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest("/notes", "POST", {
          extId: ids.note,
          title: "Citation note",
          content: "Manual",
        })
      ).status
    ).toBe(201);

    const events = [
      {
        deliveryId: `${prefix}-canonical-highlight`,
        type: "highlight.created",
        data: {
          extId: ids.highlight,
          bookExtId: ids.bookA,
          bookTitle: "Stale client title",
          citationLevel: "content",
          chapterId: "chapter-1",
          chapterTitle: "Chapter",
          text: "quoted",
          paraIndex: 0,
          start: 0,
          end: 6,
          noteExtId: ids.note,
        },
      },
      {
        deliveryId: `${prefix}-canonical-translation`,
        type: "translation.created",
        data: {
          extId: ids.translation,
          bookExtId: ids.bookA,
          bookTitle: "Stale client title",
          chapterTitle: "Chapter",
          targetLang: "中文",
          scope: "passage",
          text: "译文",
        },
      },
      {
        deliveryId: `${prefix}-canonical-mindmap`,
        type: "mindmap.created",
        data: {
          extId: ids.mindmap,
          title: "Map",
          bookExtId: ids.bookA,
          bookTitle: "Stale client title",
          root: { id: "root", text: "Root", children: [] },
        },
      },
    ];
    for (const event of events) {
      expect((await apiRequest("/events", "POST", event)).status).toBe(200);
    }

    const reimport = bookBody(ids.bookA, "Canonical", sharedHash);
    expect(
      (
        await apiRequest("/events", "POST", {
          deliveryId: `${prefix}-canonical-reimport`,
          type: "book.imported",
          data: reimport,
        })
      ).status
    ).toBe(200);

    const delayedEvents = [
      {
        deliveryId: `${prefix}-delayed-highlight`,
        type: "highlight.updated",
        data: {
          extId: ids.highlight,
          bookTitle: "Original",
          note: "late update",
        },
      },
      {
        deliveryId: `${prefix}-delayed-translation`,
        type: "translation.created",
        data: {
          extId: ids.translation,
          bookExtId: ids.bookA,
          bookTitle: "Original",
          chapterTitle: "Chapter",
          targetLang: "中文",
          scope: "passage",
          text: "延迟译文",
        },
      },
      {
        deliveryId: `${prefix}-delayed-mindmap`,
        type: "mindmap.updated",
        data: {
          extId: ids.mindmap,
          title: "Late map",
          bookTitle: "Original",
          root: { id: "root", text: "Late root", children: [] },
        },
      },
    ];
    for (const event of delayedEvents) {
      expect((await apiRequest("/events", "POST", event)).status).toBe(200);
    }

    const database = getDb();
    const [[book], [highlight], [translation], [mindmap], [note]] =
      await Promise.all([
        database
          .select({ title: mirrorBooks.title })
          .from(mirrorBooks)
          .where(eq(mirrorBooks.extId, ids.bookA)),
        database
          .select({ bookTitle: mirrorHighlights.bookTitle })
          .from(mirrorHighlights)
          .where(eq(mirrorHighlights.extId, ids.highlight)),
        database
          .select({ bookTitle: mirrorTranslations.bookTitle })
          .from(mirrorTranslations)
          .where(eq(mirrorTranslations.extId, ids.translation)),
        database
          .select({ bookTitle: mirrorMindmaps.bookTitle })
          .from(mirrorMindmaps)
          .where(eq(mirrorMindmaps.extId, ids.mindmap)),
        database
          .select({ content: mirrorNotes.content })
          .from(mirrorNotes)
          .where(eq(mirrorNotes.extId, ids.note)),
      ]);
    expect(book.title).toBe("Canonical");
    expect([
      highlight.bookTitle,
      translation.bookTitle,
      mindmap.bookTitle,
    ]).toEqual(["Canonical", "Canonical", "Canonical"]);
    expect(note.content).toContain("[[Canonical]]");
    expect(note.content).not.toContain("[[Original]]");
    expect(note.content).not.toContain("[[Stale client title]]");
  }, 30_000);

  it("rewrites large citation notes, cascades every child, and rejects late writes", async () => {
    await cleanup();
    expect(
      (
        await apiRequest(
          "/books",
          "POST",
          bookBody(ids.bookA, "Original", sharedHash)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest(
          "/books",
          "POST",
          bookBody(ids.bookB, "Peer", sharedHash)
        )
      ).status
    ).toBe(201);
    const legacyRetry = bookBody(ids.bookA, "Original", sharedHash) as Record<
      string,
      unknown
    >;
    delete legacyRetry.metadata;
    expect((await apiRequest("/books", "POST", legacyRetry)).status).toBe(201);
    const [preservedBook] = await getDb()
      .select({ metadata: mirrorBooks.metadata })
      .from(mirrorBooks)
      .where(eq(mirrorBooks.extId, ids.bookA));
    expect(preservedBook.metadata).toContain("Metadata Press");

    const citation = "> quoted\n\n—— [[Original]] → Chapter → 具体内容";
    const largePrefix = "🙂".repeat(20_000);
    expect(
      (
        await apiRequest("/notes", "POST", {
          extId: ids.note,
          title: "Large note",
          content: `${largePrefix}\n\n${citation}\n`,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest("/highlights", "POST", {
          extId: ids.highlight,
          bookExtId: ids.bookA,
          bookTitle: "Original",
          citationLevel: "content",
          chapterId: "chapter-1",
          chapterTitle: "Chapter",
          text: "quoted",
          paraIndex: 0,
          start: 0,
          end: 6,
          styleKind: "none",
          noteExtId: ids.note,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest("/translations", "POST", {
          extId: ids.translation,
          bookExtId: ids.bookA,
          bookTitle: "Original",
          chapterTitle: "Chapter",
          targetLang: "中文",
          text: "译文",
        })
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest("/mindmaps", "POST", {
          extId: ids.mindmap,
          title: "Map",
          bookExtId: ids.bookA,
          bookTitle: "Original",
          root: { id: "root", text: "Root", children: [] },
        })
      ).status
    ).toBe(201);

    const source: PassageAnchor = {
      kind: "text",
      bookId: ids.bookA,
      chapterId: "chapter-1",
      chapterTitle: "Chapter",
      text: "quoted",
      paraIndex: 0,
      start: 0,
      end: 6,
    };
    const target: PassageAnchor = {
      ...source,
      bookId: ids.bookB,
    };
    const direction = "bidirectional" as const;
    expect(
      (
        await apiRequest("/associations", "POST", {
          extId: ids.association,
          source,
          target,
          direction,
          pairKey: associationPairKey(source, target, direction),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      ).status
    ).toBe(201);
    await getDb()
      .insert(mirrorBookUploadChunks)
      .values({
        bookExtId: ids.bookA,
        uploadId: `${prefix}-upload`,
        chunkIndex: -1,
        chunkCount: 1,
        encodedBytes: 2,
        title: "Original",
        author: "Alice",
        format: "txt",
        chapterCount: 0,
        payload: "",
      });
    await getDb().insert(bookDigests).values({
      contentHash: sharedHash,
      title: "Original",
      author: "Alice",
      structure: "{}",
    });

    const uploadId = `${prefix}-rename-upload`;
    const chaptersJson = JSON.stringify([
      { id: "chapter-1", title: "Chapter", paragraphs: ["quoted"] },
    ]);
    const uploadManifest = {
      extId: ids.bookA,
      uploadId,
      chunkCount: 1,
      encodedBytes: Buffer.byteLength(chaptersJson, "utf8"),
    };
    expect(
      (
        await apiRequest("/events", "POST", {
          type: "book.import.started",
          data: {
            ...uploadManifest,
            title: "Chunk Renamed",
            author: "Alice",
            format: "txt",
            folder: "",
            contentHash: sharedHash,
            chapterCount: 1,
          },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await apiRequest("/events", "POST", {
          type: "book.import.chunk",
          data: {
            extId: ids.bookA,
            uploadId,
            index: 0,
            chunkCount: 1,
            payload: chaptersJson,
          },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await apiRequest("/events", "POST", {
          type: "book.import.completed",
          data: uploadManifest,
        })
      ).status
    ).toBe(200);
    const [chunkRenamedNote] = await getDb()
      .select({ content: mirrorNotes.content })
      .from(mirrorNotes)
      .where(eq(mirrorNotes.extId, ids.note));
    expect(chunkRenamedNote.content).toContain("[[Chunk Renamed]]");
    expect(chunkRenamedNote.content).not.toContain("[[Original]]");

    const renamed = await apiRequest(`/books/${ids.bookA}`, "PATCH", {
      title: "Renamed",
      author: "Alice",
      metadata: {
        version: 1,
        contributors: [{ name: "Alice", role: "author" }],
      },
    });
    expect(renamed.status).toBe(200);
    const [renamedNote] = await getDb()
      .select({ content: mirrorNotes.content })
      .from(mirrorNotes)
      .where(eq(mirrorNotes.extId, ids.note));
    expect(renamedNote.content).toContain("[[Renamed]]");
    expect(renamedNote.content).not.toContain("[[Original]]");
    expect(Buffer.byteLength(renamedNote.content, "utf8")).toBeGreaterThan(
      65_535
    );
    expect(
      await getDb()
        .select()
        .from(bookDigests)
        .where(eq(bookDigests.contentHash, sharedHash))
    ).toHaveLength(0);
    await getDb().insert(bookDigests).values({
      contentHash: sharedHash,
      title: "Renamed",
      author: "Alice",
      structure: "{}",
    });

    expect((await apiRequest(`/books/${ids.bookA}`, "DELETE")).status).toBe(
      200
    );
    const database = getDb();
    const [bookRows, highlightRows, translationRows, mindmapRows, chunkRows] =
      await Promise.all([
        database
          .select()
          .from(mirrorBooks)
          .where(eq(mirrorBooks.extId, ids.bookA)),
        database
          .select()
          .from(mirrorHighlights)
          .where(eq(mirrorHighlights.bookExtId, ids.bookA)),
        database
          .select()
          .from(mirrorTranslations)
          .where(eq(mirrorTranslations.bookExtId, ids.bookA)),
        database
          .select()
          .from(mirrorMindmaps)
          .where(eq(mirrorMindmaps.bookExtId, ids.bookA)),
        database
          .select()
          .from(mirrorBookUploadChunks)
          .where(eq(mirrorBookUploadChunks.bookExtId, ids.bookA)),
      ]);
    expect([
      bookRows,
      highlightRows,
      translationRows,
      mindmapRows,
      chunkRows,
    ]).toEqual([[], [], [], [], []]);
    expect(
      await database
        .select()
        .from(mirrorAssociations)
        .where(
          or(
            eq(mirrorAssociations.sourceBookExtId, ids.bookA),
            eq(mirrorAssociations.targetBookExtId, ids.bookA)
          )
        )
    ).toHaveLength(0);
    const [cleanedNote] = await database
      .select({ content: mirrorNotes.content })
      .from(mirrorNotes)
      .where(eq(mirrorNotes.extId, ids.note));
    expect(cleanedNote.content).not.toContain("[[Renamed]]");
    expect(cleanedNote.content).toContain(largePrefix.slice(0, 16));
    expect(
      await database
        .select()
        .from(bookDigests)
        .where(eq(bookDigests.contentHash, sharedHash))
    ).toHaveLength(1);

    const lateHighlight = await apiRequest("/highlights", "POST", {
      extId: `${ids.highlight}-late`,
      bookExtId: ids.bookA,
      bookTitle: "Renamed",
      citationLevel: "content",
      chapterId: "chapter-1",
      chapterTitle: "Chapter",
      text: "late",
      paraIndex: 0,
      start: 0,
      end: 4,
    });
    expect(lateHighlight.status).toBe(404);
    expect(await lateHighlight.json()).toMatchObject({
      error: "book_not_found",
    });
    expect(
      await database
        .select()
        .from(mirrorHighlights)
        .where(eq(mirrorHighlights.bookExtId, ids.bookA))
    ).toHaveLength(0);
    const lateImport = await apiRequest("/events", "POST", {
      deliveryId: `${prefix}-late-import-0001`,
      type: "book.imported",
      data: bookBody(ids.bookA, "Stale", sharedHash),
    });
    expect(lateImport.status).toBe(409);
    expect(
      await database
        .select()
        .from(mirrorBooks)
        .where(eq(mirrorBooks.extId, ids.bookA))
    ).toHaveLength(0);
  }, 30_000);

  it("removes one shared digest after concurrent deletion of the final books", async () => {
    await cleanup();
    await apiRequest(
      "/books",
      "POST",
      bookBody(ids.bookC, "C", concurrentHash)
    );
    await apiRequest(
      "/books",
      "POST",
      bookBody(ids.bookD, "D", concurrentHash)
    );
    await getDb().insert(bookDigests).values({
      contentHash: concurrentHash,
      title: "C",
      author: "Alice",
      structure: "{}",
    });
    const responses = await Promise.all([
      apiRequest(`/books/${ids.bookC}`, "DELETE"),
      apiRequest(`/books/${ids.bookD}`, "DELETE"),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(
      await getDb()
        .select()
        .from(bookDigests)
        .where(eq(bookDigests.contentHash, concurrentHash))
    ).toHaveLength(0);
  }, 30_000);

  it("clears partial uploads, records browser tombstones, and rejects resurrection", async () => {
    await cleanup();
    const uploadId = `${prefix}-partial-upload`;
    const started = await apiRequest("/events", "POST", {
      deliveryId: `${prefix}-partial-start`,
      type: "book.import.started",
      data: {
        extId: ids.partialBook,
        uploadId,
        chunkCount: 1,
        encodedBytes: 2,
        title: "Partial",
        author: "Alice",
        format: "txt",
        folder: "",
        contentHash: stagedHash,
        chapterCount: 0,
      },
    });
    expect(started.status).toBe(200);
    expect(
      await getDb()
        .select()
        .from(mirrorBookUploadChunks)
        .where(eq(mirrorBookUploadChunks.bookExtId, ids.partialBook))
    ).toHaveLength(1);

    const deleted = await apiRequest("/events", "POST", {
      deliveryId: `${prefix}-partial-delete`,
      type: "book.deleted",
      data: { extId: ids.partialBook, title: "Partial" },
    });
    expect(deleted.status).toBe(200);
    expect(
      await getDb()
        .select()
        .from(mirrorBookUploadChunks)
        .where(eq(mirrorBookUploadChunks.bookExtId, ids.partialBook))
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(mirrorBookTombstones)
        .where(eq(mirrorBookTombstones.extId, ids.partialBook))
    ).toHaveLength(1);

    expect(
      (
        await apiRequest("/events", "POST", {
          deliveryId: `${prefix}-partial-complete`,
          type: "book.import.completed",
          data: {
            extId: ids.partialBook,
            uploadId,
            chunkCount: 1,
            encodedBytes: 2,
          },
        })
      ).status
    ).toBe(409);
    expect(
      (
        await apiRequest(
          "/books",
          "POST",
          bookBody(ids.partialBook, "Resurrected", stagedHash)
        )
      ).status
    ).toBe(409);

    expect(
      (await apiRequest(`/books/${ids.absentBook}`, "DELETE")).status
    ).toBe(404);
    expect(
      await getDb()
        .select()
        .from(mirrorBookTombstones)
        .where(eq(mirrorBookTombstones.extId, ids.absentBook))
    ).toHaveLength(0);
    expect(
      (
        await apiRequest(
          "/books",
          "POST",
          bookBody(ids.absentBook, "Allowed", stagedHash)
        )
      ).status
    ).toBe(201);

    expect(
      (
        await apiRequest("/events", "POST", {
          deliveryId: `${prefix}-queued-delete`,
          type: "book.deleted",
          data: { extId: ids.queuedBook, title: "Queued" },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await apiRequest("/events", "POST", {
          deliveryId: `${prefix}-queued-start`,
          type: "book.import.started",
          data: {
            extId: ids.queuedBook,
            uploadId: `${prefix}-queued-upload`,
            chunkCount: 1,
            encodedBytes: 2,
            title: "Queued",
            author: "Alice",
            format: "txt",
            folder: "",
            contentHash: stagedHash,
            chapterCount: 0,
          },
        })
      ).status
    ).toBe(409);
  }, 30_000);

  it("deletes stale-tab citation anchors and unlinks enriched highlights", async () => {
    await cleanup();
    expect(
      (
        await apiRequest(
          "/books",
          "POST",
          bookBody(ids.bookA, "Note owner", sharedHash)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest("/notes", "POST", {
          extId: ids.deletedNote,
          title: "Disposable",
          content: "Body",
        })
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest("/highlights", "POST", {
          extId: ids.highlight,
          bookExtId: ids.bookA,
          bookTitle: "Note owner",
          citationLevel: "content",
          chapterId: "chapter-1",
          chapterTitle: "Chapter",
          text: "quoted",
          paraIndex: 0,
          start: 0,
          end: 6,
          styleKind: "none",
          noteExtId: ids.deletedNote,
        })
      ).status
    ).toBe(201);
    const enrichedHighlightId = `${ids.highlight}-enriched`;
    const namedHighlightId = `${ids.highlight}-named`;
    expect(
      (
        await apiRequest("/highlights", "POST", {
          extId: enrichedHighlightId,
          bookExtId: ids.bookA,
          bookTitle: "Stale title is ignored",
          citationLevel: "content",
          chapterId: "chapter-1",
          chapterTitle: "Chapter",
          text: "enriched quote",
          paraIndex: 0,
          start: 0,
          end: 14,
          styleKind: "none",
          note: "Keep this personal annotation",
          noteExtId: ids.deletedNote,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await apiRequest("/highlights", "POST", {
          extId: namedHighlightId,
          bookExtId: ids.bookA,
          bookTitle: "Stale title is ignored",
          citationLevel: "content",
          chapterId: "chapter-1",
          chapterTitle: "Chapter",
          text: "named quote",
          paraIndex: 0,
          start: 0,
          end: 11,
          styleKind: "none",
          name: "Keep this named card",
          noteExtId: ids.deletedNote,
        })
      ).status
    ).toBe(201);

    const deleted = await apiRequest("/events", "POST", {
      deliveryId: `${prefix}-stale-tab-note-delete`,
      type: "note.deleted",
      data: { extId: ids.deletedNote },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      ok: true,
      deletedHighlightIds: [ids.highlight],
    });
    expect(
      await getDb()
        .select()
        .from(mirrorHighlights)
        .where(eq(mirrorHighlights.extId, ids.highlight))
    ).toHaveLength(0);
    const [enrichedHighlight] = await getDb()
      .select({
        note: mirrorHighlights.note,
        noteExtId: mirrorHighlights.noteExtId,
      })
      .from(mirrorHighlights)
      .where(eq(mirrorHighlights.extId, enrichedHighlightId));
    expect(enrichedHighlight).toMatchObject({
      note: "Keep this personal annotation",
      noteExtId: null,
    });
    const [namedHighlight] = await getDb()
      .select({
        name: mirrorHighlights.name,
        noteExtId: mirrorHighlights.noteExtId,
      })
      .from(mirrorHighlights)
      .where(eq(mirrorHighlights.extId, namedHighlightId));
    expect(namedHighlight).toMatchObject({
      name: "Keep this named card",
      noteExtId: null,
    });
    expect(
      await getDb()
        .select()
        .from(mirrorNoteTombstones)
        .where(eq(mirrorNoteTombstones.extId, ids.deletedNote))
    ).toHaveLength(1);

    expect(
      (
        await apiRequest("/events", "POST", {
          deliveryId: `${prefix}-stale-note`,
          type: "note.updated",
          data: {
            extId: ids.deletedNote,
            title: "Disposable",
            content: "Stale resurrection",
            updatedAt: Date.now() + 60_000,
          },
        })
      ).status
    ).toBe(200);
    expect(
      await getDb()
        .select()
        .from(mirrorNotes)
        .where(eq(mirrorNotes.extId, ids.deletedNote))
    ).toHaveLength(0);
  }, 30_000);

  it("cannot leave a digest orphaned when save races final-book deletion", async () => {
    await cleanup();
    expect(
      (
        await apiRequest(
          "/books",
          "POST",
          bookBody(ids.digestBook, "Digest race", raceHash)
        )
      ).status
    ).toBe(201);

    const [saved, deleted] = await Promise.all([
      getDb().transaction(transaction =>
        saveDigestIfReferenced(transaction, {
          contentHash: raceHash,
          title: "Digest race",
          author: "Alice",
          structure: "{}",
          overview: "Overview",
        })
      ),
      apiRequest(`/books/${ids.digestBook}`, "DELETE"),
    ]);
    expect(typeof saved).toBe("boolean");
    expect(deleted.status).toBe(200);
    expect(
      await getDb()
        .select()
        .from(mirrorBooks)
        .where(eq(mirrorBooks.extId, ids.digestBook))
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(bookDigests)
        .where(eq(bookDigests.contentHash, raceHash))
    ).toHaveLength(0);
  }, 30_000);
});
