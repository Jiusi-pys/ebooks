import type {
  BookContributor,
  BookContributorRole,
  BookIdentifier,
  BookMetadata,
} from "@/types";
import { MAX_BOOK_METADATA_BYTES } from "./bookMetadata";

const CONTRIBUTOR_ROLES = new Set<BookContributorRole>([
  "author",
  "editor",
  "translator",
  "illustrator",
  "other",
]);

export interface ImportedMetadataInput {
  subtitle?: string;
  contributors?: BookContributor[];
  publishers?: string[];
  publishedDates?: string[];
  languages?: string[];
  identifiers?: { scheme?: string; value: string }[];
  subjects?: string[];
  descriptions?: string[];
  rights?: string[];
}

function metadataBytes(metadata: BookMetadata): number {
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
}

function safePrefix(value: string, end: number): string {
  let prefix = value.slice(0, end);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function restoreWithinBudget(
  metadata: BookMetadata,
  key: "description" | "rights",
  original: string | undefined
) {
  if (!original) return;
  let low = 0;
  let high = original.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = safePrefix(original, middle);
    metadata[key] = candidate || undefined;
    if (metadataBytes(metadata) <= MAX_BOOK_METADATA_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  metadata[key] = best || undefined;
}

function removeTailUntilBudget<T>(
  metadata: BookMetadata,
  read: () => T[] | undefined,
  write: (values: T[] | undefined) => void
) {
  while (metadataBytes(metadata) > MAX_BOOK_METADATA_BYTES) {
    const values = read();
    if (!values?.length) break;
    const shortened = values.slice(0, -1);
    write(shortened.length ? shortened : undefined);
  }
}

/** Keep imported metadata inside the same MySQL TEXT budget as manual edits. */
function fitMetadataBudget(metadata: BookMetadata): BookMetadata {
  if (metadataBytes(metadata) <= MAX_BOOK_METADATA_BYTES) return metadata;

  const description = metadata.description;
  const rights = metadata.rights;
  metadata.description = undefined;
  metadata.rights = undefined;

  removeTailUntilBudget(
    metadata,
    () => metadata.subjects,
    values => (metadata.subjects = values)
  );
  removeTailUntilBudget(
    metadata,
    () => metadata.identifiers,
    values => (metadata.identifiers = values)
  );
  removeTailUntilBudget(
    metadata,
    () => metadata.languages,
    values => (metadata.languages = values)
  );
  removeTailUntilBudget(
    metadata,
    () => metadata.contributors,
    values => (metadata.contributors = values)
  );
  if (metadataBytes(metadata) > MAX_BOOK_METADATA_BYTES) {
    metadata.publisher = undefined;
    metadata.subtitle = undefined;
  }
  restoreWithinBudget(metadata, "description", description);
  restoreWithinBudget(metadata, "rights", rights);
  return metadata;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll("\0", "").trim();
  if (!text) return undefined;
  let bounded = text.slice(0, max);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    bounded = bounded.slice(0, -1);
  }
  return bounded || undefined;
}

function uniqueText(
  values: readonly string[] | undefined,
  maxCount: number,
  maxCharacters: number
): string[] {
  const unique = new Map<string, string>();
  for (const value of values ?? []) {
    const text = boundedText(value, maxCharacters);
    if (!text) continue;
    const key = text.toLowerCase();
    if (!unique.has(key)) unique.set(key, text);
    if (unique.size === maxCount) break;
  }
  return [...unique.values()];
}

function joinedText(
  values: readonly string[] | undefined,
  separator: string,
  maxCharacters: number
): string | undefined {
  const parts = uniqueText(values, 32, maxCharacters);
  return boundedText(parts.join(separator), maxCharacters);
}

export function normalizeImportedDate(value: string): string | undefined {
  const text = boundedText(value, 128);
  const match = text?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?=$|T|\s)/);
  if (!match) return undefined;
  const normalized = [match[1], match[2], match[3]]
    .filter((part): part is string => Boolean(part))
    .join("-");
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;
  const parsed = new Date(Date.UTC(Number(match[1]), month - 1, day));
  return parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? normalized
    : undefined;
}

function normalizeLanguage(value: string): string | undefined {
  const text = boundedText(value.replaceAll("_", "-"), 64);
  if (!text) return undefined;
  try {
    return Intl.getCanonicalLocales(text)[0];
  } catch {
    return undefined;
  }
}

function normalizeIdentifier(identifier: {
  scheme?: string;
  value: string;
}): BookIdentifier | undefined {
  let value = boundedText(identifier.value, 255);
  if (!value) return undefined;
  const hint = boundedText(identifier.scheme, 32)?.toLowerCase() ?? "";
  const lowerValue = value.toLowerCase();
  let scheme = "ID";

  if (hint === "isbn" || /^urn:isbn:/i.test(value)) {
    scheme = "ISBN";
    value = value.replace(/^urn:isbn:/i, "");
  } else if (
    hint === "doi" ||
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i.test(value)
  ) {
    scheme = "DOI";
    value = value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "");
  } else if (hint === "asin" || /^asin:/i.test(value)) {
    scheme = "ASIN";
    value = value.replace(/^asin:/i, "");
  } else if (hint === "uuid" || /^urn:uuid:/i.test(value)) {
    scheme = "UUID";
    value = value.replace(/^urn:uuid:/i, "");
  } else if (/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(hint)) {
    scheme = hint.toUpperCase();
  } else if (/^(?:97[89])?\d[\d -]{8,16}[\dX]$/i.test(lowerValue)) {
    scheme = "ISBN";
  }

  value = boundedText(value, 255);
  return value ? { scheme, value } : undefined;
}

/**
 * Normalize untrusted embedded book metadata before it reaches IndexedDB or
 * the MySQL mirror. Optional malformed values are skipped, not allowed to make
 * an otherwise readable book fail to import.
 */
export function importedBookMetadata(
  input: ImportedMetadataInput
): BookMetadata | undefined {
  const contributorKeys = new Set<string>();
  const contributors: BookContributor[] = [];
  let authorCharacters = 0;
  for (const contributor of input.contributors ?? []) {
    const name = boundedText(contributor.name, 255);
    if (!name || !CONTRIBUTOR_ROLES.has(contributor.role)) continue;
    const key = `${contributor.role}\0${name.toLowerCase()}`;
    if (contributorKeys.has(key)) continue;
    if (contributor.role === "author") {
      const nextLength =
        authorCharacters + (authorCharacters ? 1 : 0) + name.length;
      if (nextLength > 255) continue;
      authorCharacters = nextLength;
    }
    contributorKeys.add(key);
    contributors.push({ name, role: contributor.role });
    if (contributors.length === 32) break;
  }

  const languages = uniqueText(
    (input.languages ?? [])
      .map(normalizeLanguage)
      .filter((value): value is string => Boolean(value)),
    32,
    64
  );
  const identifiers: BookIdentifier[] = [];
  const identifierKeys = new Set<string>();
  for (const raw of input.identifiers ?? []) {
    const identifier = normalizeIdentifier(raw);
    if (!identifier) continue;
    const key = `${identifier.scheme.toLowerCase()}\0${identifier.value}`;
    if (identifierKeys.has(key)) continue;
    identifierKeys.add(key);
    identifiers.push(identifier);
    if (identifiers.length === 32) break;
  }

  const publishedDate = (input.publishedDates ?? [])
    .map(normalizeImportedDate)
    .find((value): value is string => Boolean(value));
  const metadata: BookMetadata = {
    version: 1,
    subtitle: boundedText(input.subtitle, 255),
    contributors: contributors.length ? contributors : undefined,
    publisher: joinedText(input.publishers, "；", 255),
    publishedDate,
    languages: languages.length ? languages : undefined,
    identifiers: identifiers.length ? identifiers : undefined,
    subjects: uniqueText(input.subjects, 32, 64),
    description: joinedText(input.descriptions, "\n", 20_000),
    rights: joinedText(input.rights, "\n", 2_000),
  };
  if (!metadata.subjects?.length) metadata.subjects = undefined;

  const boundedMetadata = fitMetadataBudget(metadata);
  return Object.entries(boundedMetadata).some(
    ([key, value]) => key !== "version" && value !== undefined
  )
    ? boundedMetadata
    : undefined;
}
