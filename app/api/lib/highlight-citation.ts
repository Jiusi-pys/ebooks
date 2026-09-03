import { z } from "zod";

export const citationLevelSchema = z.enum(["book", "chapter", "content"]);
export type CitationLevel = z.infer<typeof citationLevelSchema>;

const normalizedCoordinate = z.number().finite().min(0).max(1);

export const pdfAnchorSchema = z
  .object({
    page: z.number().int().min(1).max(1_000_000),
    rects: z
      .array(
        z
          .object({
            x: normalizedCoordinate,
            y: normalizedCoordinate,
            width: normalizedCoordinate.positive(),
            height: normalizedCoordinate.positive(),
          })
          .strict()
          .superRefine((rect, ctx) => {
            if (rect.x + rect.width > 1.000_001) {
              ctx.addIssue({
                code: "custom",
                path: ["width"],
                message: "x + width must not exceed 1",
              });
            }
            if (rect.y + rect.height > 1.000_001) {
              ctx.addIssue({
                code: "custom",
                path: ["height"],
                message: "y + height must not exceed 1",
              });
            }
          })
      )
      .min(1)
      .max(256),
  })
  .strict();

export type PdfAnchor = z.infer<typeof pdfAnchorSchema>;

const optionalPosition = z.number().int().min(0).max(20_000_000).optional();
const nullablePosition = z
  .number()
  .int()
  .min(0)
  .max(20_000_000)
  .nullable()
  .optional();

/** Fields embedded in POST /highlights. Missing level means legacy content. */
export const citationCreateShape = {
  citationLevel: citationLevelSchema.default("content"),
  chapterId: z.string().max(64).default(""),
  paraIndex: optionalPosition,
  start: optionalPosition,
  end: optionalPosition,
  pdfAnchor: pdfAnchorSchema.optional(),
} as const;

/** Nullable values in PATCH explicitly clear an optional anchor. */
export const citationPatchShape = {
  citationLevel: citationLevelSchema.optional(),
  chapterId: z.string().max(64).nullable().optional(),
  paraIndex: nullablePosition,
  start: nullablePosition,
  end: nullablePosition,
  pdfAnchor: pdfAnchorSchema.nullable().optional(),
} as const;

export interface CitationInput {
  citationLevel?: CitationLevel;
  chapterId?: string | null;
  paraIndex?: number | null;
  start?: number | null;
  end?: number | null;
  pdfAnchor?: PdfAnchor | null;
}

export interface StoredCitation {
  citationLevel: CitationLevel;
  chapterId: string;
  paraIndex: number | null;
  start: number | null;
  end: number | null;
  pdfAnchor: PdfAnchor | null;
}

function hasContentAnchor(input: CitationInput): boolean {
  return (
    input.paraIndex != null ||
    input.start != null ||
    input.end != null ||
    input.pdfAnchor != null
  );
}

export function validateCitationCreate(
  input: CitationInput,
  ctx: z.RefinementCtx
): void {
  const level = input.citationLevel ?? "content";
  if (level === "book") {
    if ((input.chapterId ?? "") !== "" || hasContentAnchor(input)) {
      ctx.addIssue({
        code: "custom",
        path: ["citationLevel"],
        message: "book citations cannot contain chapter or content anchors",
      });
    }
    return;
  }

  if (level === "chapter") {
    if (!input.chapterId) {
      ctx.addIssue({
        code: "custom",
        path: ["chapterId"],
        message: "chapterId is required for chapter citations",
      });
    }
    if (hasContentAnchor(input)) {
      ctx.addIssue({
        code: "custom",
        path: ["citationLevel"],
        message: "chapter citations cannot contain content anchors",
      });
    }
    return;
  }

  validateRange(input.start, input.end, ctx);
}

function validateRange(
  start: number | null | undefined,
  end: number | null | undefined,
  ctx: z.RefinementCtx
): void {
  if ((start == null) !== (end == null)) {
    ctx.addIssue({
      code: "custom",
      path: [start == null ? "start" : "end"],
      message: "start and end must be supplied together",
    });
  } else if (start != null && end != null && end <= start) {
    ctx.addIssue({
      code: "custom",
      path: ["end"],
      message: "end must be greater than start",
    });
  }
}

/**
 * Merge a partial update with stored data, enforce hierarchy invariants, and
 * clear anchors that no longer apply after a level transition.
 */
export function resolveCitationPatch(
  current: StoredCitation,
  patch: CitationInput
):
  | { success: true; data: StoredCitation }
  | { success: false; message: string } {
  const level = patch.citationLevel ?? current.citationLevel;
  const chapterId =
    patch.chapterId === null
      ? ""
      : patch.chapterId === undefined
        ? current.chapterId
        : patch.chapterId;

  if (level === "book") {
    if ((patch.chapterId ?? "") !== "" || hasContentAnchor(patch)) {
      return {
        success: false,
        message: "book citations cannot contain chapter or content anchors",
      };
    }
    return {
      success: true,
      data: {
        citationLevel: level,
        chapterId: "",
        paraIndex: null,
        start: null,
        end: null,
        pdfAnchor: null,
      },
    };
  }

  if (level === "chapter") {
    if (!chapterId) {
      return {
        success: false,
        message: "chapterId is required for chapter citations",
      };
    }
    if (hasContentAnchor(patch)) {
      return {
        success: false,
        message: "chapter citations cannot contain content anchors",
      };
    }
    return {
      success: true,
      data: {
        citationLevel: level,
        chapterId,
        paraIndex: null,
        start: null,
        end: null,
        pdfAnchor: null,
      },
    };
  }

  const next: StoredCitation = {
    citationLevel: level,
    chapterId,
    paraIndex:
      patch.paraIndex === undefined ? current.paraIndex : patch.paraIndex,
    start: patch.start === undefined ? current.start : patch.start,
    end: patch.end === undefined ? current.end : patch.end,
    pdfAnchor:
      patch.pdfAnchor === undefined ? current.pdfAnchor : patch.pdfAnchor,
  };
  if ((next.start === null) !== (next.end === null)) {
    return {
      success: false,
      message: "start and end must be supplied together",
    };
  }
  if (next.start !== null && next.end !== null && next.end <= next.start) {
    return { success: false, message: "end must be greater than start" };
  }
  return { success: true, data: next };
}

export function parseStoredCitationLevel(value: string): CitationLevel {
  const parsed = citationLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : "content";
}

export function parseStoredPdfAnchor(value: string | null): PdfAnchor | null {
  if (!value) return null;
  try {
    const parsed = pdfAnchorSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializePdfAnchor(
  value: PdfAnchor | null | undefined
): string | null {
  return value == null ? null : JSON.stringify(value);
}
