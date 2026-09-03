import type {
  Association,
  AssociationDirection,
  Book,
  Chapter,
  Highlight,
  PassageAnchor,
  PdfAnchorRect,
  PdfPassageAnchor,
  TextPassageAnchor,
} from "@/types";

const PDF_IDENTITY_SCALE = 1_000_000;
const MAX_SENTENCE_CANDIDATES = 500;
const MAX_STABLE_ID_LENGTH = 64;
const MAX_CHAPTER_TITLE_LENGTH = 255;
const MAX_PASSAGE_TEXT_LENGTH = 20_000;
const MAX_TEXT_POSITION = 20_000_000;
const MAX_PDF_PAGE = 1_000_000;
const MAX_PDF_RECTS = 256;

export function isTextPassageAnchor(
  anchor: PassageAnchor
): anchor is TextPassageAnchor {
  return anchor.kind === "text";
}

export function isPdfPassageAnchor(
  anchor: PassageAnchor
): anchor is PdfPassageAnchor {
  return anchor.kind === "pdf";
}

function quantizePdfCoordinate(value: number): number {
  const rounded = Math.round(value * PDF_IDENTITY_SCALE) / PDF_IDENTITY_SCALE;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function compareNumberTuples(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Normalize renderer noise out of PDF geometry before using it as identity.
 * The stored anchor remains untouched; only the stable key uses these values.
 */
export function normalizedPdfRectTuples(
  rects: readonly PdfAnchorRect[]
): number[][] {
  return rects
    .map(rect =>
      [rect.x, rect.y, rect.width, rect.height].map(quantizePdfCoordinate)
    )
    .sort(compareNumberTuples);
}

/** Stable identity for one passage. Titles and text are snapshots, not identity. */
export function passageAnchorKey(anchor: PassageAnchor): string {
  const identity =
    anchor.kind === "text"
      ? [
          "text",
          anchor.bookId,
          anchor.chapterId,
          anchor.paraIndex,
          anchor.start,
          anchor.end,
        ]
      : [
          "pdf",
          anchor.bookId,
          anchor.pdfAnchor.page,
          normalizedPdfRectTuples(anchor.pdfAnchor.rects),
        ];
  return `${anchor.kind}:${encodeURIComponent(JSON.stringify(identity))}`;
}

/**
 * Bidirectional relations use an unordered pair; directed relations preserve
 * source-to-target order. Recreating A ↔ B as B ↔ A therefore deduplicates.
 */
export function associationPairKey(
  source: PassageAnchor,
  target: PassageAnchor,
  direction: AssociationDirection = "bidirectional"
): string {
  const keys = [passageAnchorKey(source), passageAnchorKey(target)];
  if (direction === "bidirectional") keys.sort();
  return `${direction}:${encodeURIComponent(JSON.stringify(keys))}`;
}

function commonAnchorError(anchor: PassageAnchor): string | null {
  if (!anchor.bookId.trim()) return "bookId is required";
  if (anchor.bookId.length > MAX_STABLE_ID_LENGTH)
    return `bookId must be at most ${MAX_STABLE_ID_LENGTH} characters`;
  if (!anchor.chapterId.trim()) return "chapterId is required";
  if (anchor.chapterId.length > MAX_STABLE_ID_LENGTH)
    return `chapterId must be at most ${MAX_STABLE_ID_LENGTH} characters`;
  if (anchor.chapterTitle.length > MAX_CHAPTER_TITLE_LENGTH)
    return `chapterTitle must be at most ${MAX_CHAPTER_TITLE_LENGTH} characters`;
  if (!anchor.text.trim()) return "passage text is required";
  if (anchor.text.length > MAX_PASSAGE_TEXT_LENGTH)
    return `passage text must be at most ${MAX_PASSAGE_TEXT_LENGTH} characters`;
  return null;
}

/** Return a human-readable invariant failure, or null for a precise anchor. */
export function validatePassageAnchor(anchor: PassageAnchor): string | null {
  const commonError = commonAnchorError(anchor);
  if (commonError) return commonError;

  if (anchor.kind === "text") {
    if (
      !Number.isInteger(anchor.paraIndex) ||
      anchor.paraIndex < 0 ||
      anchor.paraIndex > MAX_TEXT_POSITION
    )
      return `paraIndex must be an integer between 0 and ${MAX_TEXT_POSITION}`;
    if (
      !Number.isInteger(anchor.start) ||
      anchor.start < 0 ||
      anchor.start > MAX_TEXT_POSITION
    )
      return `start must be an integer between 0 and ${MAX_TEXT_POSITION}`;
    if (!Number.isInteger(anchor.end) || anchor.end <= anchor.start)
      return "end must be an integer greater than start";
    if (anchor.end > MAX_TEXT_POSITION)
      return `end must be at most ${MAX_TEXT_POSITION}`;
    return null;
  }

  const { page, rects } = anchor.pdfAnchor;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PDF_PAGE)
    return `PDF page must be an integer between 1 and ${MAX_PDF_PAGE}`;
  if (rects.length === 0) return "PDF anchor must contain at least one rect";
  if (rects.length > MAX_PDF_RECTS)
    return `PDF anchor must contain at most ${MAX_PDF_RECTS} rects`;
  for (const rect of rects) {
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every(Number.isFinite)) return "PDF rect values must be finite";
    if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0)
      return "PDF rect must have normalized positive geometry";
    if (
      rect.x > 1 ||
      rect.y > 1 ||
      rect.width > 1 ||
      rect.height > 1 ||
      rect.x + rect.width > 1.000_001 ||
      rect.y + rect.height > 1.000_001
    )
      return "PDF rect must stay inside the normalized page";
  }
  return null;
}

export function validateAssociationEndpoints(
  source: PassageAnchor,
  target: PassageAnchor
): string | null {
  const sourceError = validatePassageAnchor(source);
  if (sourceError) return `Invalid source: ${sourceError}`;
  const targetError = validatePassageAnchor(target);
  if (targetError) return `Invalid target: ${targetError}`;
  if (passageAnchorKey(source) === passageAnchorKey(target))
    return "A passage cannot be associated with itself";
  return null;
}

/** Convert a precise content highlight into an association endpoint. */
export function passageAnchorFromHighlight(
  highlight: Highlight
): PassageAnchor | null {
  if (highlight.citation && highlight.citation.level !== "content") return null;

  const chapterId = highlight.citation?.chapterId ?? highlight.chapterId;
  const pdfAnchor = highlight.citation?.pdfAnchor ?? highlight.pdfAnchor;
  if (pdfAnchor) {
    const anchor: PdfPassageAnchor = {
      kind: "pdf",
      bookId: highlight.bookId,
      chapterId,
      chapterTitle: highlight.chapterTitle,
      text: highlight.text,
      pdfAnchor,
    };
    return validatePassageAnchor(anchor) ? null : anchor;
  }

  const paraIndex = highlight.citation?.paraIndex ?? highlight.paraIndex;
  const start = highlight.citation?.start ?? highlight.start;
  const end = highlight.citation?.end ?? highlight.end;
  if (paraIndex === undefined || start === undefined || end === undefined)
    return null;
  const anchor: TextPassageAnchor = {
    kind: "text",
    bookId: highlight.bookId,
    chapterId,
    chapterTitle: highlight.chapterTitle,
    text: highlight.text,
    paraIndex,
    start,
    end,
  };
  return validatePassageAnchor(anchor) ? null : anchor;
}

/** Validate endpoints and return the canonical pair key used by persistence. */
export function assertAssociationEndpoints(
  source: PassageAnchor,
  target: PassageAnchor,
  direction: AssociationDirection = "bidirectional"
): string {
  const error = validateAssociationEndpoints(source, target);
  if (error) throw new TypeError(error);
  return associationPairKey(source, target, direction);
}

export function associationPeer(
  association: Association,
  anchor: PassageAnchor
): PassageAnchor | null {
  const key = passageAnchorKey(anchor);
  if (passageAnchorKey(association.source) === key) return association.target;
  if (passageAnchorKey(association.target) === key) return association.source;
  return null;
}

export function associationsForAnchor(
  associations: readonly Association[],
  anchor: PassageAnchor
): Association[] {
  const key = passageAnchorKey(anchor);
  return associations.filter(
    association =>
      passageAnchorKey(association.source) === key ||
      passageAnchorKey(association.target) === key
  );
}

export function associationsForBook(
  associations: readonly Association[],
  bookId: string
): Association[] {
  return associations.filter(
    association =>
      association.source.bookId === bookId ||
      association.target.bookId === bookId
  );
}

export interface TargetSentenceOptions {
  chapterId?: string;
  query?: string;
  limit?: number;
}

const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "；", ";"]);
const CLOSING_PUNCTUATION = new Set([
  '"',
  "'",
  "”",
  "’",
  "」",
  "』",
  "》",
  "】",
  "）",
  ")",
]);

function sentenceRanges(paragraph: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let sentenceStart = 0;

  const addRange = (rawStart: number, rawEnd: number) => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/u.test(paragraph[start])) start += 1;
    while (end > start && /\s/u.test(paragraph[end - 1])) end -= 1;
    if (end > start) ranges.push({ start, end });
  };

  for (let index = 0; index < paragraph.length; index += 1) {
    const character = paragraph[index];
    const periodEndsSentence =
      character === "." &&
      (index === paragraph.length - 1 || /\s/u.test(paragraph[index + 1]));
    if (!SENTENCE_END.has(character) && !periodEndsSentence) continue;

    let end = index + 1;
    while (end < paragraph.length && CLOSING_PUNCTUATION.has(paragraph[end]))
      end += 1;
    addRange(sentenceStart, end);
    sentenceStart = end;
    index = end - 1;
  }
  addRange(sentenceStart, paragraph.length);
  return ranges;
}

/**
 * Produce exact, selectable sentence anchors for an association target picker.
 * Results retain paragraph offsets so duplicate sentence text remains distinct.
 */
export function targetSentenceCandidates(
  book: Pick<Book, "id" | "chapters">,
  options: TargetSentenceOptions = {}
): TextPassageAnchor[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const requestedLimit = options.limit ?? 80;
  const limit = Math.min(
    MAX_SENTENCE_CANDIDATES,
    Math.max(0, Math.floor(requestedLimit))
  );
  if (limit === 0) return [];

  const candidates: TextPassageAnchor[] = [];
  for (const chapter of book.chapters) {
    if (options.chapterId && chapter.id !== options.chapterId) continue;
    for (
      let paraIndex = 0;
      paraIndex < chapter.paragraphs.length;
      paraIndex += 1
    ) {
      const paragraph = chapter.paragraphs[paraIndex];
      for (const range of sentenceRanges(paragraph)) {
        const text = paragraph.slice(range.start, range.end);
        if (query && !text.toLocaleLowerCase().includes(query)) continue;
        candidates.push({
          kind: "text",
          bookId: book.id,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          text,
          paraIndex,
          start: range.start,
          end: range.end,
        });
        if (candidates.length >= limit) return candidates;
      }
    }
  }
  return candidates;
}

/** Convenience wrapper for a picker that already selected one chapter. */
export function associationCandidatesForChapter(
  bookId: string,
  chapter: Chapter,
  options: Omit<TargetSentenceOptions, "chapterId"> = {}
): TextPassageAnchor[] {
  return targetSentenceCandidates(
    { id: bookId, chapters: [chapter] },
    { ...options, chapterId: chapter.id }
  );
}
