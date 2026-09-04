import { z } from "zod";
import {
  citationCreateShape,
  citationPatchShape,
  validateCitationCreate,
} from "./highlight-citation";
import { associationDeletedSchema, associationSchema } from "./association";
import {
  bookImportChunkSchema,
  bookImportCompletedSchema,
  bookImportStartedSchema,
} from "./book-mirror-upload";
import { bookMetadataSchema } from "./book-metadata";

const aiQaSchema = z
  .array(
    z.object({ q: z.string(), a: z.string(), ts: z.number().finite() }).strict()
  )
  .max(500);

const reviewSchema = z
  .object({
    due: z.number().finite(),
    reps: z.number().int().min(0),
    lapses: z.number().int().min(0),
    interval: z.number().finite().min(0),
    lastRating: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional(),
    lastReviewedAt: z.number().finite().optional(),
    addedAt: z.number().finite(),
  })
  .strict();

const stableExtId = z.string().min(1).max(64);
const optionalBookExtId = z.string().max(64);

const readerBookChapterSchema = z
  .object({
    id: stableExtId,
    title: z.string().min(1).max(255),
    paragraphs: z.array(z.string().max(20_000)).max(2_000),
  })
  .strict();

export const readerBookImportedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().trim().min(1).max(255),
    author: z.string().max(255).optional(),
    metadata: bookMetadataSchema.optional(),
    format: z.string().max(16).default("unknown"),
    folder: z.string().max(255).default(""),
    contentHash: z.string().max(64).default(""),
    chapters: z.array(readerBookChapterSchema).max(500),
  })
  .strict();

const readerBookDeletedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().max(255).optional(),
  })
  .strict();

const readerFolderCreatedSchema = z
  .object({
    extId: stableExtId,
    name: z.string().trim().min(1).max(255),
  })
  .strict();

const readerFolderDeletedSchema = z
  .object({
    extId: stableExtId,
    name: z.string().max(255).optional(),
  })
  .strict();

const readerStudySetSnapshotSchema = z
  .object({
    extId: stableExtId,
    name: z.string().trim().min(1).max(255),
    description: z.string().max(20_000).optional(),
    bookIds: z.array(stableExtId).max(2_000),
  })
  .strict();

const readerStudySetDeletedSchema = z.object({ extId: stableExtId }).strict();

const readerTranslationCreatedSchema = z
  .object({
    extId: stableExtId,
    bookExtId: stableExtId,
    // Accepted for compatibility, but the server never trusts this snapshot.
    bookTitle: z.string().max(255).optional(),
    chapterTitle: z.string().max(255).default(""),
    targetLang: z.string().min(1).max(32),
    scope: z.enum(["passage", "chapter"]).default("passage"),
    text: z.string().min(1).max(120_000),
    sourceLength: z.number().int().nonnegative().max(120_000).optional(),
  })
  .strict();

interface ReaderMindNode {
  id: string;
  text: string;
  chapterId?: string;
  sourceHighlightId?: string;
  collapsed?: boolean;
  children: ReaderMindNode[];
}

const readerMindNodeSchema: z.ZodType<ReaderMindNode> = z.lazy(() =>
  z
    .object({
      id: stableExtId,
      text: z.string().min(1).max(255),
      chapterId: stableExtId.optional(),
      sourceHighlightId: stableExtId.optional(),
      collapsed: z.boolean().optional(),
      children: z.array(readerMindNodeSchema).max(200).default([]),
    })
    .strict()
);

const readerMindmapCreatedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().trim().min(1).max(255),
    // Empty means a deliberately bookless, browser-only mind map.
    bookExtId: optionalBookExtId,
    // Accepted for compatibility, but the server never trusts this snapshot.
    bookTitle: z.string().max(255).optional(),
    root: readerMindNodeSchema,
    nodeCount: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict();

const readerMindmapUpdatedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().trim().min(1).max(255).optional(),
    // Empty means a deliberately bookless, browser-only mind map.
    bookExtId: optionalBookExtId.optional(),
    // Accepted for compatibility, but the server never trusts this snapshot.
    bookTitle: z.string().max(255).optional(),
    root: readerMindNodeSchema.optional(),
    nodeCount: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict()
  .refine(
    value =>
      value.title !== undefined ||
      value.bookExtId !== undefined ||
      value.root !== undefined,
    { message: "mindmap.updated requires title, bookExtId, or root" }
  );

const readerMindmapDeletedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().max(255).optional(),
  })
  .strict();

const readerHighlightTaggedSchema = z
  .object({
    extId: stableExtId,
    tags: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();

const readerReviewUpdatedSchema = z
  .object({
    extId: stableExtId,
    inReview: z.boolean().optional(),
    review: reviewSchema.nullable().optional(),
    due: z.number().finite().optional(),
    reps: z.number().int().min(0).optional(),
    lapses: z.number().int().min(0).optional(),
    rating: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional(),
  })
  .strict()
  .refine(
    value =>
      value.inReview !== undefined ||
      value.review !== undefined ||
      value.due !== undefined,
    { message: "review.updated requires a review mutation" }
  );

const readerQaRecordedSchema = z
  .object({
    extId: stableExtId,
    bookTitle: z.string().max(255).optional(),
    question: z.string().max(20_000).optional(),
    aiQa: aiQaSchema,
  })
  .strict();

const highlightMetadataShape = {
  bookExtId: stableExtId,
  bookTitle: z.string().max(255).default(""),
  chapterTitle: z.string().max(255).default(""),
  styleKind: z
    .enum(["underline", "background", "color", "none"])
    .default("underline"),
  styleColor: z.string().max(32).default("orange"),
  note: z.string().max(20_000).nullable().optional(),
  noteExtId: z.string().max(64).nullable().optional(),
  /** 旧前端解除引用时使用的字段名。 */
  noteId: z.string().max(64).nullable().optional(),
  name: z.string().max(255).nullable().optional(),
  aiQa: aiQaSchema.optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  cloze: z.array(z.string().min(1).max(255)).max(32).optional(),
  review: reviewSchema.nullable().optional(),
} as const;

export const readerHighlightCreatedSchema = z
  .object({
    ...citationCreateShape,
    ...highlightMetadataShape,
    extId: stableExtId,
    text: z.string().min(1).max(20_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateCitationCreate(value, ctx);
    if (
      value.noteExtId !== undefined &&
      value.noteId !== undefined &&
      value.noteExtId !== value.noteId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["noteExtId"],
        message: "noteExtId and legacy noteId must match",
      });
    }
  });

export const readerHighlightUpdatedSchema = z
  .object({
    ...citationPatchShape,
    extId: stableExtId,
    bookExtId: stableExtId.optional(),
    bookTitle: z.string().max(255).optional(),
    chapterTitle: z.string().max(255).optional(),
    text: z.string().min(1).max(20_000).optional(),
    styleKind: z.enum(["underline", "background", "color", "none"]).optional(),
    styleColor: z.string().max(32).optional(),
    note: z.string().max(20_000).nullable().optional(),
    noteExtId: z.string().max(64).nullable().optional(),
    noteId: z.string().max(64).nullable().optional(),
    name: z.string().max(255).nullable().optional(),
    aiQa: aiQaSchema.optional(),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
    cloze: z.array(z.string().min(1).max(255)).max(32).optional(),
    review: reviewSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.noteExtId !== undefined &&
      value.noteId !== undefined &&
      value.noteExtId !== value.noteId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["noteExtId"],
        message: "noteExtId and legacy noteId must match",
      });
    }
  });

export const readerNoteCreatedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().min(1).max(255),
    content: z.string().max(200_000),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const readerNoteUpdatedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().min(1).max(255).optional(),
    content: z.string().max(200_000).optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine(value => value.title !== undefined || value.content !== undefined, {
    message: "note.updated requires title or content",
  });

export const readerHighlightDeletedSchema = z
  .object({
    extId: stableExtId,
    bookTitle: z.string().max(255).optional(),
  })
  .strict();

export const readerNoteDeletedSchema = z
  .object({ extId: stableExtId })
  .strict();

export const readerBookUpdatedSchema = z
  .object({
    extId: stableExtId,
    title: z.string().trim().min(1).max(255).optional(),
    author: z.string().max(255).optional(),
    folder: z.string().max(255).optional(),
    metadata: bookMetadataSchema.optional(),
  })
  .strict()
  .refine(
    value =>
      value.title !== undefined ||
      value.author !== undefined ||
      value.folder !== undefined ||
      value.metadata !== undefined,
    { message: "book.updated requires at least one changed field" }
  );

type MirrorEventValidation =
  | { success: true; data: Record<string, unknown> }
  | { success: false; issues: z.core.$ZodIssue[] };

/** Validate fields that are persisted by POST /events and normalize noteId. */
export function normalizeReaderMirrorEvent(
  type: string,
  data: Record<string, unknown>
): MirrorEventValidation {
  const schema =
    type === "highlight.created"
      ? readerHighlightCreatedSchema
      : type === "highlight.updated"
        ? readerHighlightUpdatedSchema
        : type === "highlight.deleted"
          ? readerHighlightDeletedSchema
          : type === "association.created" || type === "association.updated"
            ? associationSchema
            : type === "association.deleted"
              ? associationDeletedSchema
              : type === "note.created"
                ? readerNoteCreatedSchema
                : type === "note.updated"
                  ? readerNoteUpdatedSchema
                  : type === "note.deleted"
                    ? readerNoteDeletedSchema
                    : type === "book.imported"
                      ? readerBookImportedSchema
                      : type === "book.updated"
                        ? readerBookUpdatedSchema
                        : type === "book.deleted"
                          ? readerBookDeletedSchema
                          : type === "qa.recorded"
                            ? readerQaRecordedSchema
                            : type === "folder.created"
                              ? readerFolderCreatedSchema
                              : type === "folder.deleted"
                                ? readerFolderDeletedSchema
                                : type === "studyset.created" ||
                                    type === "studyset.updated"
                                  ? readerStudySetSnapshotSchema
                                  : type === "studyset.deleted"
                                    ? readerStudySetDeletedSchema
                                    : type === "translation.created"
                                      ? readerTranslationCreatedSchema
                                      : type === "mindmap.created"
                                        ? readerMindmapCreatedSchema
                                        : type === "mindmap.updated"
                                          ? readerMindmapUpdatedSchema
                                          : type === "mindmap.deleted"
                                            ? readerMindmapDeletedSchema
                                            : type === "highlight.tagged"
                                              ? readerHighlightTaggedSchema
                                              : type === "review.updated"
                                                ? readerReviewUpdatedSchema
                                                : type === "book.import.started"
                                                  ? bookImportStartedSchema
                                                  : type === "book.import.chunk"
                                                    ? bookImportChunkSchema
                                                    : type ===
                                                        "book.import.completed"
                                                      ? bookImportCompletedSchema
                                                      : null;
  if (!schema) {
    return {
      success: false,
      issues: [
        {
          code: "custom",
          input: type,
          path: [],
          message: "unsupported reader mirror event type",
        },
      ],
    };
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) return { success: false, issues: parsed.error.issues };
  const normalized: Record<string, unknown> = { ...parsed.data };
  if (type.startsWith("highlight.")) {
    const preferred = normalized.noteExtId;
    const legacy = normalized.noteId;
    if (preferred !== undefined || legacy !== undefined) {
      normalized.noteExtId = preferred !== undefined ? preferred : legacy;
    }
    delete normalized.noteId;
  }
  return { success: true, data: normalized };
}
