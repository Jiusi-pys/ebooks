import { and, asc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";

import { mirrorBooks, mirrorBookUploadChunks } from "@db/mirror-schema";
import { getDb } from "../queries/connection";

export const BOOK_UPLOAD_MANIFEST_INDEX = -1;
export const MAX_BOOK_UPLOAD_CHUNKS = 512;
export const MAX_BOOK_UPLOAD_BYTES = 96 * 1024 * 1024;
export const MAX_BOOK_UPLOAD_CHUNK_BYTES = 512 * 1024;
export const BOOK_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_BOOK_TEXT_CHARACTERS = 70 * 1024 * 1024;

const stableId = z.string().min(1).max(64);
const uploadId = stableId.regex(/^[A-Za-z0-9._:-]+$/, "invalid uploadId");

export const bookImportStartedSchema = z
  .object({
    extId: stableId,
    uploadId,
    chunkCount: z.number().int().min(1).max(MAX_BOOK_UPLOAD_CHUNKS),
    encodedBytes: z.number().int().min(2).max(MAX_BOOK_UPLOAD_BYTES),
    title: z.string().min(1).max(255),
    author: z.string().max(255),
    format: z.string().min(1).max(16),
    folder: z.string().max(255).default(""),
    contentHash: z.string().max(64).default(""),
    chapterCount: z.number().int().min(0).max(5_000),
  })
  .strict();

export const bookImportChunkSchema = z
  .object({
    extId: stableId,
    uploadId,
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_BOOK_UPLOAD_CHUNKS - 1),
    chunkCount: z.number().int().min(1).max(MAX_BOOK_UPLOAD_CHUNKS),
    payload: z.string().min(1).max(MAX_BOOK_UPLOAD_CHUNK_BYTES),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.index >= value.chunkCount) {
      context.addIssue({
        code: "custom",
        path: ["index"],
        message: "chunk index must be smaller than chunkCount",
      });
    }
    if (
      Buffer.byteLength(value.payload, "utf8") > MAX_BOOK_UPLOAD_CHUNK_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "chunk payload exceeds the UTF-8 byte limit",
      });
    }
  });

export const bookImportCompletedSchema = z
  .object({
    extId: stableId,
    uploadId,
    chunkCount: z.number().int().min(1).max(MAX_BOOK_UPLOAD_CHUNKS),
    encodedBytes: z.number().int().min(2).max(MAX_BOOK_UPLOAD_BYTES),
  })
  .strict();

const mirrorChapterSchema = z
  .object({
    id: stableId,
    title: z.string().max(255),
    paragraphs: z.array(z.string().max(MAX_BOOK_TEXT_CHARACTERS)).max(250_000),
  })
  .strict();

const mirrorChaptersSchema = z
  .array(mirrorChapterSchema)
  .max(5_000)
  .superRefine((chapters, context) => {
    let paragraphs = 0;
    let characters = 0;
    for (const chapter of chapters) {
      paragraphs += chapter.paragraphs.length;
      for (const paragraph of chapter.paragraphs) {
        characters += paragraph.length;
      }
      if (paragraphs > 250_000 || characters > MAX_BOOK_TEXT_CHARACTERS) break;
    }
    if (paragraphs > 250_000) {
      context.addIssue({
        code: "custom",
        message: "book contains more than 250000 paragraphs",
      });
    }
    if (characters > MAX_BOOK_TEXT_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: `book contains more than ${MAX_BOOK_TEXT_CHARACTERS} characters`,
      });
    }
  });

export type BookImportStarted = z.infer<typeof bookImportStartedSchema>;
export type BookImportChunk = z.infer<typeof bookImportChunkSchema>;
export type BookImportCompleted = z.infer<typeof bookImportCompletedSchema>;

type Database = ReturnType<typeof getDb>;
type UploadRow = typeof mirrorBookUploadChunks.$inferSelect;

export type BookMirrorUploadErrorCode =
  | "upload_not_found"
  | "upload_manifest_mismatch"
  | "upload_incomplete"
  | "upload_size_mismatch"
  | "upload_invalid_json"
  | "upload_invalid_chapters";

export class BookMirrorUploadError extends Error {
  readonly code: BookMirrorUploadErrorCode;
  readonly status: 400 | 404 | 409 | 413;

  constructor(
    code: BookMirrorUploadErrorCode,
    message: string,
    status: 400 | 404 | 409 | 413 = 409
  ) {
    super(message);
    this.name = "BookMirrorUploadError";
    this.code = code;
    this.status = status;
  }
}

function uploadPredicate(extId: string, currentUploadId: string) {
  return and(
    eq(mirrorBookUploadChunks.bookExtId, extId),
    eq(mirrorBookUploadChunks.uploadId, currentUploadId)
  );
}

export async function cleanupExpiredBookMirrorUploads(
  database: Database = getDb(),
  now = Date.now()
): Promise<void> {
  const cutoff = new Date(now - BOOK_UPLOAD_TTL_MS);
  await database
    .delete(mirrorBookUploadChunks)
    .where(lt(mirrorBookUploadChunks.updatedAt, cutoff));
}

/** Create a fresh manifest and discard any older upload for the same book. */
export async function startBookMirrorUpload(
  raw: BookImportStarted,
  database: Database = getDb(),
  now = Date.now()
): Promise<void> {
  const input = bookImportStartedSchema.parse(raw);
  await database.transaction(async transaction => {
    const cutoff = new Date(now - BOOK_UPLOAD_TTL_MS);
    await transaction
      .delete(mirrorBookUploadChunks)
      .where(lt(mirrorBookUploadChunks.updatedAt, cutoff));
    await transaction
      .delete(mirrorBookUploadChunks)
      .where(eq(mirrorBookUploadChunks.bookExtId, input.extId));
    await transaction.insert(mirrorBookUploadChunks).values({
      bookExtId: input.extId,
      uploadId: input.uploadId,
      chunkIndex: BOOK_UPLOAD_MANIFEST_INDEX,
      chunkCount: input.chunkCount,
      encodedBytes: input.encodedBytes,
      title: input.title,
      author: input.author,
      format: input.format,
      folder: input.folder,
      contentHash: input.contentHash,
      chapterCount: input.chapterCount,
      payload: "",
    });
  });
}

/** Store or replace one numbered chunk after matching it to its manifest. */
export async function putBookMirrorChunk(
  raw: BookImportChunk,
  database: Database = getDb()
): Promise<void> {
  const input = bookImportChunkSchema.parse(raw);
  await database.transaction(async transaction => {
    const rows = await transaction
      .select()
      .from(mirrorBookUploadChunks)
      .where(
        and(
          uploadPredicate(input.extId, input.uploadId),
          eq(mirrorBookUploadChunks.chunkIndex, BOOK_UPLOAD_MANIFEST_INDEX)
        )
      )
      .limit(1);
    const manifest = rows[0];
    if (!manifest) {
      throw new BookMirrorUploadError(
        "upload_not_found",
        "book upload manifest does not exist",
        404
      );
    }
    if (manifest.completedAt) {
      throw new BookMirrorUploadError(
        "upload_manifest_mismatch",
        "book upload has already completed"
      );
    }
    if (manifest.chunkCount !== input.chunkCount) {
      throw new BookMirrorUploadError(
        "upload_manifest_mismatch",
        "chunkCount does not match the upload manifest"
      );
    }

    await transaction
      .insert(mirrorBookUploadChunks)
      .values({
        bookExtId: input.extId,
        uploadId: input.uploadId,
        chunkIndex: input.index,
        chunkCount: manifest.chunkCount,
        encodedBytes: manifest.encodedBytes,
        chapterCount: manifest.chapterCount,
        payload: input.payload,
      })
      .onDuplicateKeyUpdate({
        set: {
          chunkCount: manifest.chunkCount,
          encodedBytes: manifest.encodedBytes,
          payload: input.payload,
          updatedAt: new Date(),
        },
      });
  });
}

interface CompletedBookMirror {
  extId: string;
  title: string;
  author: string;
  format: string;
  folder: string;
  contentHash: string;
  chapterCount: number;
  chapters: z.infer<typeof mirrorChaptersSchema>;
  chaptersJson: string;
}

export interface BookMirrorCompletionReceipt {
  extId: string;
  title: string;
  author: string;
  format: string;
  folder: string;
  contentHash: string;
  chapterCount: number;
  alreadyCompleted: boolean;
}

function completionReceipt(
  manifest: UploadRow,
  alreadyCompleted: boolean
): BookMirrorCompletionReceipt {
  return {
    extId: manifest.bookExtId,
    title: manifest.title,
    author: manifest.author,
    format: manifest.format,
    folder: manifest.folder,
    contentHash: manifest.contentHash,
    chapterCount: manifest.chapterCount,
    alreadyCompleted,
  };
}

/** Strictly validate ordered staging rows before their transactional promotion. */
export function assembleBookMirrorUpload(
  input: BookImportCompleted,
  rows: UploadRow[]
): CompletedBookMirror {
  const manifest = rows.find(
    row => row.chunkIndex === BOOK_UPLOAD_MANIFEST_INDEX
  );
  if (!manifest) {
    throw new BookMirrorUploadError(
      "upload_not_found",
      "book upload manifest does not exist",
      404
    );
  }
  if (
    manifest.bookExtId !== input.extId ||
    manifest.uploadId !== input.uploadId ||
    manifest.chunkCount !== input.chunkCount ||
    manifest.encodedBytes !== input.encodedBytes
  ) {
    throw new BookMirrorUploadError(
      "upload_manifest_mismatch",
      "completion metadata does not match the upload manifest"
    );
  }

  const chunks = rows
    .filter(row => row.chunkIndex >= 0)
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (chunks.length !== manifest.chunkCount) {
    throw new BookMirrorUploadError(
      "upload_incomplete",
      "book upload does not contain every declared chunk"
    );
  }
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (
      chunk.chunkIndex !== index ||
      chunk.chunkCount !== manifest.chunkCount ||
      chunk.encodedBytes !== manifest.encodedBytes
    ) {
      throw new BookMirrorUploadError(
        "upload_incomplete",
        "book upload chunk indexes or metadata are inconsistent"
      );
    }
  }

  const chaptersJson = chunks.map(chunk => chunk.payload).join("");
  if (Buffer.byteLength(chaptersJson, "utf8") !== manifest.encodedBytes) {
    throw new BookMirrorUploadError(
      "upload_size_mismatch",
      "book upload UTF-8 byte count does not match the manifest",
      413
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(chaptersJson);
  } catch {
    throw new BookMirrorUploadError(
      "upload_invalid_json",
      "book upload is not valid chapter JSON",
      400
    );
  }
  const parsed = mirrorChaptersSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.length !== manifest.chapterCount) {
    throw new BookMirrorUploadError(
      "upload_invalid_chapters",
      "book upload chapters do not match the declared structure",
      400
    );
  }

  return {
    extId: manifest.bookExtId,
    title: manifest.title,
    author: manifest.author,
    format: manifest.format,
    folder: manifest.folder,
    contentHash: manifest.contentHash,
    chapterCount: manifest.chapterCount,
    chapters: parsed.data,
    chaptersJson,
  };
}

/** Validate, promote, and clear one completed upload in a single transaction. */
export async function completeBookMirrorUpload(
  raw: BookImportCompleted,
  database: Database = getDb()
): Promise<BookMirrorCompletionReceipt> {
  const input = bookImportCompletedSchema.parse(raw);
  return database.transaction(async transaction => {
    const rows = await transaction
      .select()
      .from(mirrorBookUploadChunks)
      .where(uploadPredicate(input.extId, input.uploadId))
      .orderBy(asc(mirrorBookUploadChunks.chunkIndex))
      .for("update");
    const manifest = rows.find(
      row => row.chunkIndex === BOOK_UPLOAD_MANIFEST_INDEX
    );
    if (!manifest) {
      throw new BookMirrorUploadError(
        "upload_not_found",
        "book upload manifest does not exist",
        404
      );
    }
    if (
      manifest.bookExtId !== input.extId ||
      manifest.uploadId !== input.uploadId ||
      manifest.chunkCount !== input.chunkCount ||
      manifest.encodedBytes !== input.encodedBytes
    ) {
      throw new BookMirrorUploadError(
        "upload_manifest_mismatch",
        "completion metadata does not match the upload manifest"
      );
    }
    if (manifest.completedAt) return completionReceipt(manifest, true);

    const completed = assembleBookMirrorUpload(input, rows);

    await transaction
      .insert(mirrorBooks)
      .values({
        extId: completed.extId,
        title: completed.title,
        author: completed.author,
        format: completed.format,
        folder: completed.folder,
        contentHash: completed.contentHash,
        chapters: completed.chaptersJson,
      })
      .onDuplicateKeyUpdate({
        set: {
          title: completed.title,
          author: completed.author,
          format: completed.format,
          folder: completed.folder,
          contentHash: completed.contentHash,
          chapters: completed.chaptersJson,
        },
      });
    await transaction
      .delete(mirrorBookUploadChunks)
      .where(
        and(
          uploadPredicate(input.extId, input.uploadId),
          gte(mirrorBookUploadChunks.chunkIndex, 0)
        )
      );
    await transaction
      .update(mirrorBookUploadChunks)
      .set({ completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          uploadPredicate(input.extId, input.uploadId),
          eq(mirrorBookUploadChunks.chunkIndex, BOOK_UPLOAD_MANIFEST_INDEX)
        )
      );

    return completionReceipt(manifest, false);
  });
}

export function isBookMirrorUploadEvent(type: string): boolean {
  return (
    type === "book.import.started" ||
    type === "book.import.chunk" ||
    type === "book.import.completed"
  );
}
