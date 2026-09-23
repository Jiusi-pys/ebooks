export type BilingualLanguage = "中文" | "现代汉语";

export interface ParagraphAnchor {
  /** Zero-based paragraph index in the pane that emitted the anchor. */
  index: number;
  /** Position inside that paragraph, from its top (0) to bottom (1). */
  ratio: number;
}

export interface TranslationChunk {
  text: string;
  sourceParagraphCount: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Pick the opposite reading language for the first bilingual session. */
export function inferTargetLanguage(
  paragraphs: readonly string[]
): BilingualLanguage {
  const sample = paragraphs.join(" ").slice(0, 12_000);
  return /[\u3400-\u9fff]/.test(sample) ? "现代汉语" : "中文";
}

/**
 * Turn the chapter-mode model response back into display paragraphs.
 *
 * The prompt asks the model to keep blank-line paragraph boundaries. Some
 * models instead return exactly one non-empty line per source paragraph, so
 * accept that form only when its count is unambiguous. Any remaining mismatch
 * is deliberately preserved: scroll synchronization interpolates between the
 * two paragraph coordinate systems instead of duplicating or dropping text.
 */
export function splitTranslatedParagraphs(
  text: string,
  expectedCount?: number
): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const blocks = normalized
    .split(/\n[\t ]*\n+/)
    .map(block => block.trim())
    .filter(Boolean);
  if (blocks.length > 1 || expectedCount === undefined || expectedCount <= 1) {
    return blocks;
  }

  const lines = normalized
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  return lines.length === expectedCount ? lines : blocks;
}

/** Build requests comfortably below the server's 120,000 character limit. */
export function chunkChapterForTranslation(
  paragraphs: readonly string[],
  maxChars = 100_000
): TranslationChunk[] {
  const limit = Math.max(1, Math.min(110_000, Math.trunc(maxChars)));
  const chunks: TranslationChunk[] = [];
  let batch: string[] = [];
  let batchLength = 0;

  const flush = () => {
    if (batch.length === 0) return;
    chunks.push({
      text: batch.join("\n\n"),
      sourceParagraphCount: batch.length,
    });
    batch = [];
    batchLength = 0;
  };

  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if (paragraph.length > limit) {
      flush();
      for (let start = 0; start < paragraph.length; start += limit) {
        chunks.push({
          text: paragraph.slice(start, start + limit),
          sourceParagraphCount: 1,
        });
      }
      continue;
    }

    const separatorLength = batch.length > 0 ? 2 : 0;
    if (batchLength + separatorLength + paragraph.length > limit) flush();
    batch.push(paragraph);
    batchLength += (batch.length > 1 ? 2 : 0) + paragraph.length;
  }
  flush();
  return chunks;
}

/** Convert a paragraph-relative anchor to a stable 0..1 chapter coordinate. */
export function paragraphAnchorProgress(
  anchor: ParagraphAnchor,
  paragraphCount: number
): number {
  if (paragraphCount <= 0) return 0;
  const index = Math.min(
    paragraphCount - 1,
    Math.max(0, Math.trunc(anchor.index))
  );
  return clamp01((index + clamp01(anchor.ratio)) / paragraphCount);
}

/** Convert a stable chapter coordinate into a paragraph-relative anchor. */
export function paragraphAnchorAtProgress(
  progress: number,
  paragraphCount: number
): ParagraphAnchor {
  if (paragraphCount <= 0) return { index: 0, ratio: 0 };
  const scaled = clamp01(progress) * paragraphCount;
  if (scaled >= paragraphCount) {
    return { index: paragraphCount - 1, ratio: 1 };
  }
  const index = Math.floor(scaled);
  return { index, ratio: scaled - index };
}

/**
 * Map a visible paragraph position between panes.
 *
 * Equal paragraph counts map exactly. If the model merged or split paragraphs,
 * the source's relative paragraph coordinate is linearly interpolated into the
 * translated paragraph set. This keeps a reader near the same semantic region
 * without relying on unequal whole-document pixel heights.
 */
export function interpolateParagraphAnchor(
  anchor: ParagraphAnchor,
  sourceParagraphCount: number,
  targetParagraphCount: number
): ParagraphAnchor {
  return paragraphAnchorAtProgress(
    paragraphAnchorProgress(anchor, sourceParagraphCount),
    targetParagraphCount
  );
}
