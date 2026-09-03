import { describe, expect, it } from "vitest";

import { mirrorBooks, mirrorBookUploadChunks } from "@db/mirror-schema";
import {
  assembleBookMirrorUpload,
  bookImportChunkSchema,
  bookImportStartedSchema,
  completeBookMirrorUpload,
  putBookMirrorChunk,
  startBookMirrorUpload,
  type BookImportCompleted,
} from "./book-mirror-upload";

type UploadRow = Parameters<typeof assembleBookMirrorUpload>[1][number];

const chapters = [
  { id: "chapter-1", title: "第一章", paragraphs: ["正文🙂", "下一段"] },
];
const chaptersJson = JSON.stringify(chapters);
const encodedBytes = Buffer.byteLength(chaptersJson, "utf8");
const completion: BookImportCompleted = {
  extId: "book-1",
  uploadId: "upload-1",
  chunkCount: 2,
  encodedBytes,
};

function row(overrides: Partial<UploadRow> = {}): UploadRow {
  return {
    bookExtId: "book-1",
    uploadId: "upload-1",
    chunkIndex: -1,
    chunkCount: 2,
    encodedBytes,
    title: "分块测试",
    author: "作者",
    format: "epub",
    folder: "资料",
    contentHash: "hash",
    chapterCount: 1,
    payload: "",
    completedAt: null,
    createdAt: new Date("2026-09-04T00:00:00Z"),
    updatedAt: new Date("2026-09-04T00:00:00Z"),
    ...overrides,
  };
}

function validRows(): UploadRow[] {
  const split = Math.floor(chaptersJson.length / 2);
  return [
    row(),
    row({ chunkIndex: 1, payload: chaptersJson.slice(split) }),
    row({ chunkIndex: 0, payload: chaptersJson.slice(0, split) }),
  ];
}

interface FakeState {
  inserted: { table: unknown; value: Record<string, unknown> }[];
  upserted: Record<string, unknown>[];
  deleted: unknown[];
  updated: Record<string, unknown>[];
}

function fakeDatabase(rows: UploadRow[] = []) {
  const state: FakeState = {
    inserted: [],
    upserted: [],
    deleted: [],
    updated: [],
  };
  let currentRows = [...rows];
  const operations = {
    delete: (table: unknown) => ({
      where: async () => {
        state.deleted.push(table);
        if (table === mirrorBookUploadChunks) {
          currentRows = currentRows.filter(item => item.chunkIndex < 0);
        }
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          state.updated.push(value);
          currentRows = currentRows.map(item =>
            item.chunkIndex === -1 ? { ...item, ...value } : item
          );
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        state.inserted.push({ table, value });
        return {
          onDuplicateKeyUpdate: async ({
            set,
          }: {
            set: Record<string, unknown>;
          }) => {
            state.upserted.push(set);
          },
        };
      },
    }),
    select: () => ({
      from: () => {
        const builder = {
          where: () => builder,
          limit: async (count: number) => currentRows.slice(0, count),
          orderBy: () => builder,
          for: async () => currentRows,
        };
        return builder;
      },
    }),
  };
  const database = {
    transaction: async <T>(work: (tx: typeof operations) => Promise<T>) =>
      work(operations),
    ...operations,
  };
  return { database, state };
}

describe("book mirror upload validation", () => {
  it("assembles out-of-order chunks into the exact chapter snapshot", () => {
    expect(assembleBookMirrorUpload(completion, validRows())).toMatchObject({
      extId: "book-1",
      title: "分块测试",
      chapterCount: 1,
      chapters,
      chaptersJson,
    });
  });

  it("rejects missing or discontinuous indexes", () => {
    expect(() =>
      assembleBookMirrorUpload({ ...completion, chunkCount: 1 }, [
        row({ chunkCount: 1 }),
        row({ chunkIndex: 1, chunkCount: 1 }),
      ])
    ).toThrow("indexes or metadata are inconsistent");
  });

  it("rejects a UTF-8 byte-count mismatch before JSON parsing", () => {
    expect(() =>
      assembleBookMirrorUpload(
        { ...completion, encodedBytes: encodedBytes + 1 },
        validRows().map(item => ({
          ...item,
          encodedBytes: encodedBytes + 1,
        }))
      )
    ).toThrow("UTF-8 byte count");
  });

  it("rejects structurally invalid chapter JSON", () => {
    const invalidJson = JSON.stringify([{ id: "chapter-1" }]);
    const bytes = Buffer.byteLength(invalidJson, "utf8");
    expect(() =>
      assembleBookMirrorUpload(
        { ...completion, chunkCount: 1, encodedBytes: bytes },
        [
          row({ chunkCount: 1, encodedBytes: bytes }),
          row({
            chunkIndex: 0,
            chunkCount: 1,
            encodedBytes: bytes,
            payload: invalidJson,
          }),
        ]
      )
    ).toThrow("declared structure");
  });

  it("measures chunk limits as UTF-8 bytes, not JavaScript characters", () => {
    const result = bookImportChunkSchema.safeParse({
      extId: "book-1",
      uploadId: "upload-1",
      index: 0,
      chunkCount: 1,
      payload: "🙂".repeat(140_000),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a declared ASCII book above 50 MiB without allocating its body", () => {
    expect(
      bookImportStartedSchema.safeParse({
        extId: "large-book",
        uploadId: "large-upload",
        chunkCount: 128,
        encodedBytes: 64 * 1024 * 1024,
        title: "Large plain-text book",
        author: "",
        format: "txt",
        chapterCount: 1,
      }).success
    ).toBe(true);
  });
});

describe("book mirror upload persistence", () => {
  it("cleans expired rows and resets a book to one fresh manifest", async () => {
    const { database, state } = fakeDatabase();
    await startBookMirrorUpload(
      {
        ...completion,
        title: "分块测试",
        author: "作者",
        format: "epub",
        folder: "资料",
        contentHash: "hash",
        chapterCount: 1,
      },
      database as never
    );

    expect(state.deleted).toEqual([
      mirrorBookUploadChunks,
      mirrorBookUploadChunks,
    ]);
    expect(state.inserted).toContainEqual({
      table: mirrorBookUploadChunks,
      value: expect.objectContaining({
        bookExtId: "book-1",
        uploadId: "upload-1",
        chunkIndex: -1,
        payload: "",
      }),
    });
  });

  it("upserts duplicate chunk indexes after checking the manifest", async () => {
    const { database, state } = fakeDatabase([row()]);
    await putBookMirrorChunk(
      {
        extId: "book-1",
        uploadId: "upload-1",
        index: 0,
        chunkCount: 2,
        payload: "payload",
      },
      database as never
    );

    expect(state.inserted[0]).toMatchObject({
      table: mirrorBookUploadChunks,
      value: { chunkIndex: 0, payload: "payload" },
    });
    expect(state.upserted[0]).toMatchObject({ payload: "payload" });
  });

  it("promotes once and preserves an idempotent completion receipt", async () => {
    const { database, state } = fakeDatabase(validRows());
    const first = await completeBookMirrorUpload(completion, database as never);
    // Simulates a committed first response being lost on the network: the
    // client retries the same completed event against the retained marker.
    const second = await completeBookMirrorUpload(
      completion,
      database as never
    );

    expect(first).toMatchObject({
      extId: "book-1",
      title: "分块测试",
      chapterCount: 1,
      alreadyCompleted: false,
    });
    expect(second).toMatchObject({
      extId: "book-1",
      alreadyCompleted: true,
    });
    expect(first).not.toHaveProperty("chapters");
    expect(
      state.inserted.filter(operation => operation.table === mirrorBooks)
    ).toEqual([
      {
        table: mirrorBooks,
        value: expect.objectContaining({
          extId: "book-1",
          chapters: chaptersJson,
        }),
      },
    ]);
    expect(state.upserted[0]).toMatchObject({ chapters: chaptersJson });
    expect(state.deleted).toEqual([mirrorBookUploadChunks]);
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0].completedAt).toBeInstanceOf(Date);
  });
});
