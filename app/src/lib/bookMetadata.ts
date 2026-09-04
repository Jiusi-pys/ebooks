import type {
  Book,
  BookContributor,
  BookContributorRole,
  BookIdentifier,
  BookMetadata,
} from "@/types";

export interface BookMetadataDraft {
  title: string;
  subtitle: string;
  authors: string;
  editors: string;
  translators: string;
  illustrators: string;
  otherContributors: string;
  publisher: string;
  publishedDate: string;
  languages: string;
  isbn: string;
  doi: string;
  asin: string;
  otherIdentifiers: string;
  series: string;
  seriesIndex: string;
  subjects: string;
  description: string;
  edition: string;
  rights: string;
  rating: string;
}

export interface EditableBookMetadata {
  title: string;
  author: string;
  metadata: BookMetadata;
}

export const MAX_BOOK_METADATA_BYTES = 60_000;

const ROLE_DRAFT_KEYS: Record<
  Exclude<BookContributorRole, "author">,
  keyof BookMetadataDraft
> = {
  editor: "editors",
  translator: "translators",
  illustrator: "illustrators",
  other: "otherContributors",
};

function joinContributorNames(
  contributors: BookContributor[] | undefined,
  role: BookContributorRole
): string {
  return (contributors ?? [])
    .filter(item => item.role === role)
    .map(item => item.name)
    .join("；");
}

function identifierValues(
  identifiers: BookIdentifier[] | undefined,
  scheme: string
): string[] {
  return (identifiers ?? [])
    .filter(
      identifier => identifier.scheme.toLowerCase() === scheme.toLowerCase()
    )
    .map(identifier => identifier.value);
}

export function bookMetadataDraft(book: Book): BookMetadataDraft {
  const metadata = book.metadata;
  const knownSchemes = new Set(["isbn", "doi", "asin"]);
  const structuredAuthors = joinContributorNames(
    metadata?.contributors,
    "author"
  );
  const isbn = identifierValues(metadata?.identifiers, "isbn");
  const doi = identifierValues(metadata?.identifiers, "doi");
  const asin = identifierValues(metadata?.identifiers, "asin");
  const seenKnownSchemes = new Set<string>();
  return {
    title: book.title,
    subtitle: metadata?.subtitle ?? "",
    // Structured contributors are authoritative; legacy rows fall back to the
    // top-level display field until their metadata is edited.
    authors: structuredAuthors || book.author,
    editors: joinContributorNames(metadata?.contributors, "editor"),
    translators: joinContributorNames(metadata?.contributors, "translator"),
    illustrators: joinContributorNames(metadata?.contributors, "illustrator"),
    otherContributors: joinContributorNames(metadata?.contributors, "other"),
    publisher: metadata?.publisher ?? "",
    publishedDate: metadata?.publishedDate ?? "",
    languages: metadata?.languages?.join(", ") ?? "",
    isbn: isbn[0] ?? "",
    doi: doi[0] ?? "",
    asin: asin[0] ?? "",
    otherIdentifiers:
      metadata?.identifiers
        ?.filter(item => {
          const scheme = item.scheme.toLowerCase();
          if (!knownSchemes.has(scheme)) return true;
          if (seenKnownSchemes.has(scheme)) return true;
          seenKnownSchemes.add(scheme);
          return false;
        })
        .map(item => `${item.scheme}: ${item.value}`)
        .join("\n") ?? "",
    series: metadata?.series ?? "",
    seriesIndex:
      metadata?.seriesIndex === undefined ? "" : String(metadata.seriesIndex),
    subjects: metadata?.subjects?.join(", ") ?? "",
    description: metadata?.description ?? "",
    edition: metadata?.edition ?? "",
    rights: metadata?.rights ?? "",
    rating: metadata?.rating === undefined ? "" : String(metadata.rating),
  };
}

function trimmed(value: string, label: string, max: number): string {
  const result = value.trim();
  if (result.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return result;
}

function splitNames(value: string, label: string): string[] {
  const names = value
    .split(/[；;\n]+/)
    .map(name => trimmed(name, label, 255))
    .filter(Boolean);
  if (names.length > 32) throw new Error(`${label}最多填写 32 位`);
  return Array.from(new Set(names));
}

function splitList(value: string, label: string): string[] {
  const items = value
    .split(/[,，；;\n]+/)
    .map(item => trimmed(item, label, 64))
    .filter(Boolean);
  if (items.length > 32) throw new Error(`${label}最多填写 32 项`);
  return Array.from(new Set(items));
}

function validatePublishedDate(value: string): string | undefined {
  const date = value.trim();
  if (!date) return undefined;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date);
  if (!match) throw new Error("出版日期应为 YYYY、YYYY-MM 或 YYYY-MM-DD");
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;
  const parsed = new Date(Date.UTC(Number(match[1]), month - 1, day));
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("出版日期不是有效日期");
  }
  return date;
}

function languagesOf(value: string): string[] {
  const languages = splitList(value, "语言");
  for (const language of languages) {
    if (
      !/^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|x(?:-[A-Za-z0-9]{1,8})+)$/i.test(
        language
      )
    ) {
      throw new Error(`语言标签“${language}”不是有效的 BCP 47 格式`);
    }
  }
  return languages;
}

function identifiersOf(draft: BookMetadataDraft): BookIdentifier[] {
  const identifiers: BookIdentifier[] = [];
  for (const [scheme, value] of [
    ["ISBN", draft.isbn],
    ["DOI", draft.doi],
    ["ASIN", draft.asin],
  ] as const) {
    const normalized = trimmed(value, scheme, 255);
    if (normalized) identifiers.push({ scheme, value: normalized });
  }

  for (const [index, line] of draft.otherIdentifiers.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error(`其他标识符第 ${index + 1} 行应为“类型: 值”`);
    }
    const scheme = trimmed(line.slice(0, separator), "标识符类型", 32);
    const value = trimmed(line.slice(separator + 1), "标识符", 255);
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(scheme) || !value) {
      throw new Error(`其他标识符第 ${index + 1} 行格式无效`);
    }
    identifiers.push({ scheme, value });
  }

  const unique = new Map<string, BookIdentifier>();
  for (const identifier of identifiers) {
    unique.set(
      `${identifier.scheme.toLowerCase()}\0${identifier.value}`,
      identifier
    );
  }
  if (unique.size > 32) throw new Error("标识符最多填写 32 项");
  return [...unique.values()];
}

function optional(value: string): string | undefined {
  return value || undefined;
}

export function normalizeBookMetadataDraft(
  draft: BookMetadataDraft
): EditableBookMetadata {
  const title = trimmed(draft.title, "书名", 255);
  if (!title) throw new Error("书名不能为空");

  const authors = splitNames(draft.authors, "作者");
  const contributors: BookContributor[] = authors.map(name => ({
    name,
    role: "author",
  }));
  for (const [role, key] of Object.entries(ROLE_DRAFT_KEYS) as [
    Exclude<BookContributorRole, "author">,
    keyof BookMetadataDraft,
  ][]) {
    contributors.push(
      ...splitNames(String(draft[key]), "贡献者").map(name => ({ name, role }))
    );
  }
  if (contributors.length > 64) {
    throw new Error("作者与其他贡献者合计最多填写 64 位");
  }
  const author = authors.join("；");
  if (author.length > 255) {
    throw new Error("作者汇总后不能超过 255 个字符，请缩短姓名或减少作者");
  }

  const seriesIndexText = draft.seriesIndex.trim();
  const seriesIndex = seriesIndexText ? Number(seriesIndexText) : undefined;
  if (
    seriesIndex !== undefined &&
    (!Number.isFinite(seriesIndex) || seriesIndex < 0 || seriesIndex > 100_000)
  ) {
    throw new Error("系列序号应为 0 到 100000 之间的数字");
  }

  const ratingText = draft.rating.trim();
  const rating = ratingText ? Number(ratingText) : undefined;
  if (
    rating !== undefined &&
    (!Number.isFinite(rating) || rating < 0 || rating > 5)
  ) {
    throw new Error("个人评分应为 0 到 5 之间的数字");
  }

  const languages = languagesOf(draft.languages);
  const identifiers = identifiersOf(draft);
  const subjects = splitList(draft.subjects, "主题/标签");
  const subtitle = trimmed(draft.subtitle, "副标题", 255);
  const publisher = trimmed(draft.publisher, "出版社", 255);
  const series = trimmed(draft.series, "系列", 255);
  const description = trimmed(draft.description, "简介", 20_000);
  const edition = trimmed(draft.edition, "版次", 128);
  const rights = trimmed(draft.rights, "版权信息", 2_000);

  const normalized: EditableBookMetadata = {
    title,
    author,
    metadata: {
      version: 1,
      subtitle: optional(subtitle),
      contributors: contributors.length ? contributors : undefined,
      publisher: optional(publisher),
      publishedDate: validatePublishedDate(draft.publishedDate),
      languages: languages.length ? languages : undefined,
      identifiers: identifiers.length ? identifiers : undefined,
      series: optional(series),
      seriesIndex,
      subjects: subjects.length ? subjects : undefined,
      description: optional(description),
      edition: optional(edition),
      rights: optional(rights),
      rating,
    },
  };
  if (
    new TextEncoder().encode(JSON.stringify(normalized.metadata)).byteLength >
    MAX_BOOK_METADATA_BYTES
  ) {
    throw new Error("元数据内容过长，请缩短简介、版权信息或列表字段");
  }
  return normalized;
}

export function recentBooks(books: Book[], limit = 6): Book[] {
  return [...books]
    .sort((left, right) => {
      const leftOpened = left.lastOpenedAt !== undefined;
      const rightOpened = right.lastOpenedAt !== undefined;
      if (leftOpened !== rightOpened) return leftOpened ? -1 : 1;
      if (leftOpened && rightOpened) {
        return (
          (right.lastOpenedAt as number) - (left.lastOpenedAt as number) ||
          right.createdAt - left.createdAt
        );
      }
      return right.createdAt - left.createdAt;
    })
    .slice(0, Math.max(0, limit));
}
