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

const highlightMetadataShape = {
  bookExtId: z.string().max(64).default(""),
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
    extId: z.string().min(1).max(64),
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
    extId: z.string().min(1).max(64),
    bookExtId: z.string().max(64).optional(),
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
    extId: z.string().min(1).max(64),
    title: z.string().min(1).max(255),
    content: z.string().max(200_000),
  })
  .strict();

export const readerNoteUpdatedSchema = z
  .object({
    extId: z.string().min(1).max(64),
    title: z.string().min(1).max(255).optional(),
    content: z.string().max(200_000).optional(),
  })
  .strict()
  .refine(value => value.title !== undefined || value.content !== undefined, {
    message: "note.updated requires title or content",
  });

export const readerHighlightDeletedSchema = z
  .object({
    extId: z.string().min(1).max(64),
    bookTitle: z.string().max(255).optional(),
  })
  .strict();

export const readerNoteDeletedSchema = z
  .object({ extId: z.string().min(1).max(64) })
  .strict();

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
                    : type === "book.import.started"
                      ? bookImportStartedSchema
                      : type === "book.import.chunk"
                        ? bookImportChunkSchema
                        : type === "book.import.completed"
                          ? bookImportCompletedSchema
                          : null;
  if (!schema) return { success: true, data };

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
