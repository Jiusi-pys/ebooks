import { createHash } from "node:crypto";
import { z } from "zod";
import type { Book } from "../../src/types";

const image = z
  .string()
  .max(12 * 1024 * 1024)
  .regex(
    /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=\s]+$/
  );
export const readerStateSchema = z
  .object({
    cover: image.nullable().optional(),
    customCover: image.nullable().optional(),
    coverTone: z.number().int().min(0).max(100).optional(),
    createdAt: z.number().finite().min(0).optional(),
    lastOpenedAt: z.number().finite().min(0).optional(),
    progress: z
      .object({
        chapterId: z.string().max(64),
        ratio: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    readerMode: z.enum(["reflow", "original"]).optional(),
    pageCount: z.number().int().min(0).max(100_000).optional(),
    outline: z
      .array(
        z
          .object({
            id: z.string().max(128),
            title: z.string().max(2000),
            chapterId: z.string().max(64).optional(),
            paraIndex: z.number().int().min(0).optional(),
            depth: z.number().int().min(0).max(100),
          })
          .strict()
      )
      .max(20_000)
      .optional(),
  })
  .strict();
export type ReaderState = z.infer<typeof readerStateSchema>;
export const sourceSchema = z
  .object({
    uploadId: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024 * 1024),
    chunks: z.number().int().min(1).max(1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(500),
    type: z.string().max(100),
  })
  .strict()
  .refine(
    value => value.uploadId === value.sha256,
    "source id must equal hash"
  );

export function validateSourceChunks(
  source: { size: number; chunks: number; sha256: string },
  chunks: { chunkIndex: number; payload: string }[]
) {
  if (
    chunks.length !== source.chunks ||
    chunks.some((chunk, index) => chunk.chunkIndex !== index)
  )
    throw new Error("source_incomplete");
  const bytes = Buffer.concat(
    chunks.map(chunk => Buffer.from(chunk.payload, "base64"))
  );
  if (
    bytes.length !== source.size ||
    createHash("sha256").update(bytes).digest("hex") !== source.sha256
  )
    throw new Error("source_integrity_failed");
  return bytes;
}

export function restoreBook(row: {
  extId: string;
  title: string;
  author: string;
  format: string;
  folder: string;
  contentHash: string;
  metadata: string | null;
  readerData: string | null;
  chapters: string;
  createdAt: Date;
}): Book {
  const chapters = JSON.parse(row.chapters) as Book["chapters"];
  const state = readerStateSchema.parse(JSON.parse(row.readerData ?? "{}"));
  const { cover, customCover, ...rest } = state;
  return {
    id: row.extId,
    title: row.title,
    author: row.author,
    format: row.format as Book["format"],
    coverTone: 0,
    createdAt: row.createdAt.getTime(),
    progress: { chapterId: chapters[0]?.id ?? "", ratio: 0 },
    ...rest,
    ...(cover ? { cover } : {}),
    ...(customCover ? { customCover } : {}),
    chapters,
    folderId: row.folder || undefined,
    contentHash: row.contentHash,
    ...(row.metadata
      ? { metadata: JSON.parse(row.metadata) as Book["metadata"] }
      : {}),
  };
}
