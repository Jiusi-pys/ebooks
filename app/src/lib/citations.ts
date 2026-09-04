import type { CitationLevel, Highlight } from "@/types";

export interface CitationDescriptor {
  /** 旧调用缺省时按具体内容引用处理。 */
  level?: CitationLevel;
  /** Stable source id used to distinguish otherwise identical citations. */
  highlightId?: string;
  bookTitle: string;
  chapterTitle?: string;
  text?: string;
}

const CITATION_MARKER_PREFIX = "<!-- shufang-citation-id:";

function citationMarker(highlightId: string): string {
  // Percent-encode `-` as well so untrusted ids cannot create `--` inside an
  // HTML comment. Markdown renderers hide the marker while raw notes remain
  // portable text.
  const encoded = encodeURIComponent(highlightId).replace(/-/g, "%2D");
  return `${CITATION_MARKER_PREFIX}${encoded} -->`;
}

function citationBody({
  level = "content",
  bookTitle,
  chapterTitle = "",
  text = "",
}: CitationDescriptor): string {
  if (level === "book") return `> 书籍引用：[[${bookTitle}]]`;
  if (level === "chapter")
    return `> 章节引用：[[${bookTitle}]] → ${chapterTitle}`;

  const quoted = text
    .trim()
    .split(/\r?\n/)
    .map(line => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n—— [[${bookTitle}]] → ${chapterTitle} → 具体内容`;
}

/** Build the Markdown block stored in the target note for a structured citation. */
export function citationBlock(descriptor: CitationDescriptor): string {
  const body = citationBody(descriptor);
  return descriptor.highlightId
    ? `${citationMarker(descriptor.highlightId)}\n${body}`
    : body;
}

/** 读取引用层级；升级前的数据都是从已选正文生成，按内容级兼容。 */
export function citationLevelOf(highlight: Highlight): CitationLevel {
  return highlight.citation?.level ?? "content";
}

/** 从持久化书摘恢复生成笔记块所需的结构化描述。 */
export function citationDescriptorForHighlight(
  highlight: Highlight,
  bookTitle: string
): CitationDescriptor {
  return {
    level: citationLevelOf(highlight),
    highlightId: highlight.id,
    bookTitle,
    chapterTitle: highlight.chapterTitle,
    text: highlight.text,
  };
}

function legacyContentBlock({
  bookTitle,
  chapterTitle = "",
  text = "",
}: CitationDescriptor): string {
  const quoted = text
    .trim()
    .split(/\r?\n/)
    .map(line => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n—— [[${bookTitle}]] · ${chapterTitle}`;
}

function citationBlockVariants(descriptor: CitationDescriptor): string[] {
  const current = citationBlock(descriptor);
  const unmarked = descriptor.highlightId
    ? citationBlock({ ...descriptor, highlightId: undefined })
    : current;
  const variants = current === unmarked ? [current] : [current, unmarked];
  if ((descriptor.level ?? "content") === "content") {
    variants.push(legacyContentBlock(descriptor));
  }
  return [...new Set(variants)];
}

interface BlockRange {
  start: number;
  end: number;
  value: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a complete generated block, not an arbitrary substring. This keeps an
 * ordinary inline wiki-link (or a longer hand-written sentence) out of the
 * cleanup path. Both LF and CRLF notes are supported.
 */
function findCitationBlock(
  content: string,
  block: string,
  fromIndex = 0
): BlockRange | undefined {
  const body = block.split("\n").map(escapeRegExp).join("\\r?\\n");
  const matcher = new RegExp(`(^|\\r?\\n)(${body})(?=\\r?\\n|$)`, "gm");
  matcher.lastIndex = fromIndex;
  while (true) {
    const match = matcher.exec(content);
    if (!match) return undefined;
    const start = match.index + match[1].length;
    if (!block.startsWith(CITATION_MARKER_PREFIX)) {
      const prefix = content.slice(0, start).replace(/\r?\n$/, "");
      const previousLine = prefix.slice(prefix.lastIndexOf("\n") + 1).trim();
      if (
        previousLine.startsWith(CITATION_MARKER_PREFIX) &&
        previousLine.endsWith("-->")
      ) {
        matcher.lastIndex = start + match[2].length;
        continue;
      }
    }
    return {
      start,
      end: start + match[2].length,
      value: match[2],
    };
  }
}

function replaceGeneratedBlock(
  content: string,
  previous: string,
  replacement: string
): string {
  if (previous === replacement) return content;
  let next = content;
  let fromIndex = 0;
  while (true) {
    const match = findCitationBlock(next, previous, fromIndex);
    if (!match) return next;
    const lineEnding = match.value.includes("\r\n") ? "\r\n" : "\n";
    const value = replacement.replace(/\n/g, lineEnding);
    next = next.slice(0, match.start) + value + next.slice(match.end);
    fromIndex = match.start + value.length;
  }
}

function replaceFirstGeneratedBlock(
  content: string,
  previous: string,
  replacement: string
): string {
  const match = findCitationBlock(content, previous);
  if (!match) return content;
  const lineEnding = match.value.includes("\r\n") ? "\r\n" : "\n";
  const value = replacement.replace(/\n/g, lineEnding);
  return content.slice(0, match.start) + value + content.slice(match.end);
}

function removeGeneratedBlockRange(content: string, match: BlockRange): string {
  const before = content.slice(0, match.start).trimEnd();
  const after = content.slice(match.end).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

function removeEveryExactBlock(content: string, block: string): string {
  let next = content;
  while (true) {
    const match = findCitationBlock(next, block);
    if (!match) return next;
    next = removeGeneratedBlockRange(next, match);
  }
}

/** Append once so repeated clicks cannot duplicate the same citation block. */
export function appendCitationBlock(
  content: string,
  descriptor: CitationDescriptor
): string {
  const block = citationBlock(descriptor);
  const current = content.trimEnd();
  if (findCitationBlock(current, block)) return content;
  if (descriptor.highlightId) {
    // Upgrade one ambiguous pre-marker block in place. If two legacy
    // highlights shared the same text, each relationship upgrades one copy;
    // once none remain, subsequent relationships get their own marker.
    for (const legacy of citationBlockVariants(descriptor).slice(1)) {
      if (findCitationBlock(current, legacy)) {
        return replaceFirstGeneratedBlock(content, legacy, block);
      }
    }
  } else if (
    citationBlockVariants(descriptor).some(item =>
      findCitationBlock(current, item)
    )
  ) {
    return content;
  }
  return current ? `${current}\n\n${block}\n` : `${block}\n`;
}

/** Remove one matching generated block while preserving the surrounding note. */
export function removeCitationBlock(
  content: string,
  descriptor: CitationDescriptor
): string {
  const variants = citationBlockVariants(descriptor);
  if (descriptor.highlightId && findCitationBlock(content, variants[0])) {
    // A stable id is unambiguous, so remove every accidental duplicate of that
    // exact marker while leaving identical citations owned by other ids.
    return removeEveryExactBlock(content, variants[0]);
  }
  const match = variants
    .slice(descriptor.highlightId ? 1 : 0)
    .map(block => findCitationBlock(content, block))
    .find((item): item is BlockRange => item !== undefined);
  if (!match) return content;
  return removeGeneratedBlockRange(content, match);
}

/** Remove all supplied structured citations from one note. */
export function removeCitationBlocks(
  content: string,
  descriptors: CitationDescriptor[]
): string {
  return descriptors.reduce(removeCitationBlock, content);
}

/**
 * Replace one generated citation block, appending the new form when the old
 * snapshot is already absent. This makes descriptor updates idempotent while
 * leaving ordinary hand-written wiki-links untouched.
 */
export function rewriteCitationBlock(
  content: string,
  previous: CitationDescriptor,
  next: CitationDescriptor
): string {
  if (citationBlock(previous) === citationBlock(next)) return content;
  return appendCitationBlock(removeCitationBlock(content, previous), next);
}

/**
 * Rewrite only known generated citation blocks when a source book is renamed.
 * Plain hand-written `[[old title]]` links are deliberately left untouched.
 * Matching both current and legacy block shapes keeps existing libraries
 * removable after an upgrade.
 */
export function renameCitationBookTitle(
  content: string,
  descriptor: CitationDescriptor,
  nextBookTitle: string
): string {
  if (descriptor.bookTitle === nextBookTitle) return content;
  const previous = citationBlockVariants(descriptor);
  const replacementDescriptor = {
    ...descriptor,
    bookTitle: nextBookTitle,
  };
  const replacements = citationBlockVariants(replacementDescriptor);
  const markedReplacement = citationBlock(replacementDescriptor);
  if (descriptor.highlightId) {
    const marked = previous[0];
    if (findCitationBlock(content, marked)) {
      return appendCitationBlock(
        removeEveryExactBlock(content, marked),
        replacementDescriptor
      );
    }
    for (const legacy of previous.slice(1)) {
      if (findCitationBlock(content, legacy)) {
        return replaceFirstGeneratedBlock(content, legacy, markedReplacement);
      }
    }
    return content;
  }
  return previous.reduce(
    (next, block, index) =>
      replaceGeneratedBlock(next, block, replacements[index]),
    content
  );
}

/** Rewrite every citation from the renamed book in a single note. */
export function renameCitationBookTitles(
  content: string,
  descriptors: CitationDescriptor[],
  nextBookTitle: string
): string {
  return descriptors.reduce(
    (next, descriptor) =>
      renameCitationBookTitle(next, descriptor, nextBookTitle),
    content
  );
}

/** Citation-only anchors should be deleted when unlinked; enriched cards stay. */
export function isCitationOnlyHighlight(highlight: Highlight): boolean {
  return (
    !!highlight.noteId &&
    highlight.style?.kind === "none" &&
    !highlight.note &&
    !highlight.name &&
    (highlight.aiQa?.length ?? 0) === 0 &&
    (highlight.tags?.length ?? 0) === 0 &&
    (highlight.cloze?.length ?? 0) === 0 &&
    !highlight.review
  );
}
