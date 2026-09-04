import { z } from "zod";

export const MAX_BOOK_METADATA_BYTES = 60_000;

export const bookContributorSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    role: z.enum(["author", "editor", "translator", "illustrator", "other"]),
  })
  .strict();

export const bookIdentifierSchema = z
  .object({
    scheme: z.string().trim().min(1).max(32),
    value: z.string().trim().min(1).max(255),
  })
  .strict();

const publishedDateSchema = z
  .string()
  .regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/)
  .refine(value => {
    const [, yearText, monthText, dayText] =
      /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value) ?? [];
    if (!yearText) return false;
    const year = Number(yearText);
    const month = monthText ? Number(monthText) : 1;
    const day = dayText ? Number(dayText) : 1;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "invalid precision-preserving publication date");

const languageTagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|x(?:-[A-Za-z0-9]{1,8})+)$/i,
    "invalid BCP 47 language tag"
  );

export const bookMetadataSchema = z
  .object({
    version: z.literal(1),
    subtitle: z.string().max(255).optional(),
    contributors: z.array(bookContributorSchema).max(64).optional(),
    publisher: z.string().max(255).optional(),
    publishedDate: publishedDateSchema.optional(),
    languages: z.array(languageTagSchema).max(32).optional(),
    identifiers: z.array(bookIdentifierSchema).max(32).optional(),
    series: z.string().max(255).optional(),
    seriesIndex: z.number().finite().min(0).max(100_000).optional(),
    subjects: z.array(z.string().min(1).max(64)).max(32).optional(),
    description: z.string().max(20_000).optional(),
    edition: z.string().max(128).optional(),
    rights: z.string().max(2_000).optional(),
    rating: z.number().finite().min(0).max(5).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const authors = value.contributors
      ?.filter(contributor => contributor.role === "author")
      .map(contributor => contributor.name)
      .join("；");
    if (authors && authors.length > 255) {
      context.addIssue({
        code: "custom",
        path: ["contributors"],
        message: "combined author display exceeds 255 characters",
      });
    }
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BOOK_METADATA_BYTES) {
      context.addIssue({
        code: "custom",
        message: `book metadata exceeds ${MAX_BOOK_METADATA_BYTES} UTF-8 bytes`,
      });
    }
  });

export type ValidatedBookMetadata = z.infer<typeof bookMetadataSchema>;

export function serializeBookMetadata(metadata: ValidatedBookMetadata): string {
  return JSON.stringify(bookMetadataSchema.parse(metadata));
}

export function parseStoredBookMetadata(value: string): ValidatedBookMetadata {
  try {
    return bookMetadataSchema.parse(JSON.parse(value));
  } catch {
    // Rows created before extended metadata always behave as an empty v1 record.
    return { version: 1 };
  }
}
