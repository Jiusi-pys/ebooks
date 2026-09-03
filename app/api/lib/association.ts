import { createHash } from "node:crypto";
import { z } from "zod";
import { pdfAnchorSchema, type PdfAnchor } from "./highlight-citation";

const stableId = z
  .string()
  .min(1)
  .max(64)
  .refine(value => value.trim().length > 0, "identifier cannot be blank");
const position = z.number().int().min(0).max(20_000_000);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);

const passageSnapshotShape = {
  bookId: stableId,
  chapterId: stableId,
  chapterTitle: z.string().max(255),
  text: z
    .string()
    .min(1)
    .max(20_000)
    .refine(value => value.trim().length > 0, "passage text cannot be blank"),
} as const;

export const textPassageAnchorSchema = z
  .object({
    kind: z.literal("text"),
    ...passageSnapshotShape,
    paraIndex: position,
    start: position,
    end: position,
  })
  .strict()
  .superRefine((anchor, ctx) => {
    if (anchor.end <= anchor.start) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "end must be greater than start",
      });
    }
  });

export const pdfPassageAnchorSchema = z
  .object({
    kind: z.literal("pdf"),
    ...passageSnapshotShape,
    pdfAnchor: pdfAnchorSchema,
  })
  .strict();

export const passageAnchorSchema = z.discriminatedUnion("kind", [
  textPassageAnchorSchema,
  pdfPassageAnchorSchema,
]);

export type PassageAnchor = z.infer<typeof passageAnchorSchema>;
export const associationDirectionSchema = z.enum([
  "bidirectional",
  "source-to-target",
]);
export type AssociationDirection = z.infer<typeof associationDirectionSchema>;

const associationShape = {
  extId: stableId,
  source: passageAnchorSchema,
  target: passageAnchorSchema,
  direction: associationDirectionSchema,
  label: z.string().max(255).optional(),
  pairKey: z.string().min(1).max(200_000),
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

/** Full browser/API snapshot. pairKey is checked instead of trusted. */
export const associationSchema = z
  .object(associationShape)
  .strict()
  .superRefine(validateAssociationSnapshot);

export type AssociationSnapshot = z.infer<typeof associationSchema>;

export const associationPatchSchema = z
  .object({
    source: passageAnchorSchema.optional(),
    target: passageAnchorSchema.optional(),
    direction: associationDirectionSchema.optional(),
    label: z.string().max(255).nullable().optional(),
    pairKey: z.string().min(1).max(200_000).optional(),
    updatedAt: timestamp.optional(),
  })
  .strict()
  .refine(
    value =>
      value.source !== undefined ||
      value.target !== undefined ||
      value.direction !== undefined ||
      value.label !== undefined ||
      value.pairKey !== undefined ||
      value.updatedAt !== undefined,
    { message: "association patch must change at least one field" }
  );

export type AssociationPatch = z.infer<typeof associationPatchSchema>;

export const associationDeletedSchema = z.object({ extId: stableId }).strict();

function quantize(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function canonicalPdfRects(anchor: PdfAnchor): number[][] {
  return anchor.rects
    .map(rect => [
      quantize(rect.x),
      quantize(rect.y),
      quantize(rect.width),
      quantize(rect.height),
    ])
    .sort((left, right) => {
      for (let index = 0; index < left.length; index += 1) {
        const difference = left[index] - right[index];
        if (difference !== 0) return difference;
      }
      return 0;
    });
}

/** Stable source identity shared with the browser; display snapshots are excluded. */
export function passageAnchorKey(anchor: PassageAnchor): string {
  if (anchor.kind === "text") {
    return `text:${encodeURIComponent(
      JSON.stringify([
        "text",
        anchor.bookId,
        anchor.chapterId,
        anchor.paraIndex,
        anchor.start,
        anchor.end,
      ])
    )}`;
  }
  return `pdf:${encodeURIComponent(
    JSON.stringify([
      "pdf",
      anchor.bookId,
      anchor.pdfAnchor.page,
      canonicalPdfRects(anchor.pdfAnchor),
    ])
  )}`;
}

export function associationPairKey(
  source: PassageAnchor,
  target: PassageAnchor,
  direction: AssociationDirection
): string {
  const sourceKey = passageAnchorKey(source);
  const targetKey = passageAnchorKey(target);
  const pair =
    direction === "bidirectional"
      ? [sourceKey, targetKey].sort()
      : [sourceKey, targetKey];
  return `${direction}:${encodeURIComponent(JSON.stringify(pair))}`;
}

/** MySQL cannot fully index an arbitrarily long PDF pairKey; this digest does. */
export function associationPairKeyHash(pairKey: string): string {
  return createHash("sha256").update(pairKey).digest("hex");
}

function validateAssociationSnapshot(
  value: {
    source: PassageAnchor;
    target: PassageAnchor;
    direction: AssociationDirection;
    pairKey: string;
    createdAt: number;
    updatedAt: number;
  },
  ctx: z.RefinementCtx
): void {
  if (passageAnchorKey(value.source) === passageAnchorKey(value.target)) {
    ctx.addIssue({
      code: "custom",
      path: ["target"],
      message: "an association cannot link a passage to itself",
    });
  }
  const expected = associationPairKey(
    value.source,
    value.target,
    value.direction
  );
  if (value.pairKey !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["pairKey"],
      message: "pairKey does not match source, target, and direction",
    });
  }
  if (value.updatedAt < value.createdAt) {
    ctx.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "updatedAt cannot precede createdAt",
    });
  }
}

export function resolveAssociationPatch(
  current: AssociationSnapshot,
  patch: AssociationPatch,
  now = Date.now()
):
  | { success: true; data: AssociationSnapshot }
  | { success: false; issues: z.core.$ZodIssue[] } {
  const source = patch.source ?? current.source;
  const target = patch.target ?? current.target;
  const direction = patch.direction ?? current.direction;
  const next: AssociationSnapshot = {
    ...current,
    source,
    target,
    direction,
    ...(patch.label === null
      ? { label: undefined }
      : patch.label === undefined
        ? {}
        : { label: patch.label }),
    pairKey: patch.pairKey ?? associationPairKey(source, target, direction),
    updatedAt: patch.updatedAt ?? now,
  };
  const parsed = associationSchema.safeParse(next);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, issues: parsed.error.issues };
}

interface StoredAssociationRow {
  extId: string;
  sourceKind: string;
  sourceBookExtId: string;
  sourceChapterId: string;
  sourceChapterTitle: string;
  sourceText: string;
  sourceParaIndex: number | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  sourcePdfAnchor: string | null;
  targetKind: string;
  targetBookExtId: string;
  targetChapterId: string;
  targetChapterTitle: string;
  targetText: string;
  targetParaIndex: number | null;
  targetStart: number | null;
  targetEnd: number | null;
  targetPdfAnchor: string | null;
  direction: string;
  label: string | null;
  pairKey: string;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export function associationDbValues(association: AssociationSnapshot) {
  const { source, target } = association;
  return {
    extId: association.extId,
    sourceKind: source.kind,
    sourceBookExtId: source.bookId,
    sourceChapterId: source.chapterId,
    sourceChapterTitle: source.chapterTitle,
    sourceText: source.text,
    sourceParaIndex: source.kind === "text" ? source.paraIndex : null,
    sourceStart: source.kind === "text" ? source.start : null,
    sourceEnd: source.kind === "text" ? source.end : null,
    sourcePdfAnchor:
      source.kind === "pdf" ? JSON.stringify(source.pdfAnchor) : null,
    targetKind: target.kind,
    targetBookExtId: target.bookId,
    targetChapterId: target.chapterId,
    targetChapterTitle: target.chapterTitle,
    targetText: target.text,
    targetParaIndex: target.kind === "text" ? target.paraIndex : null,
    targetStart: target.kind === "text" ? target.start : null,
    targetEnd: target.kind === "text" ? target.end : null,
    targetPdfAnchor:
      target.kind === "pdf" ? JSON.stringify(target.pdfAnchor) : null,
    direction: association.direction,
    label: association.label ?? null,
    pairKey: association.pairKey,
    pairKeyHash: associationPairKeyHash(association.pairKey),
    createdAt: new Date(association.createdAt),
    updatedAt: new Date(association.updatedAt),
  };
}

function timestampMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function parseStoredAnchor(
  row: StoredAssociationRow,
  prefix: "source" | "target"
): PassageAnchor {
  const kind = row[`${prefix}Kind`];
  const common = {
    bookId: row[`${prefix}BookExtId`],
    chapterId: row[`${prefix}ChapterId`],
    chapterTitle: row[`${prefix}ChapterTitle`],
    text: row[`${prefix}Text`],
  };
  const candidate =
    kind === "pdf"
      ? {
          kind,
          ...common,
          pdfAnchor: JSON.parse(row[`${prefix}PdfAnchor`] ?? "null") as unknown,
        }
      : {
          kind,
          ...common,
          paraIndex: row[`${prefix}ParaIndex`],
          start: row[`${prefix}Start`],
          end: row[`${prefix}End`],
        };
  return passageAnchorSchema.parse(candidate);
}

export function associationFromRow(
  row: StoredAssociationRow
): AssociationSnapshot {
  return associationSchema.parse({
    extId: row.extId,
    source: parseStoredAnchor(row, "source"),
    target: parseStoredAnchor(row, "target"),
    direction: row.direction,
    ...(row.label === null ? {} : { label: row.label }),
    pairKey: row.pairKey,
    createdAt: timestampMs(row.createdAt),
    updatedAt: timestampMs(row.updatedAt),
  });
}
