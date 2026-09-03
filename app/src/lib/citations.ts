import type { CitationLevel, Highlight } from "@/types";

export interface CitationDescriptor {
  /** 旧调用缺省时按具体内容引用处理。 */
  level?: CitationLevel;
  bookTitle: string;
  chapterTitle?: string;
  text?: string;
}

/** Build the Markdown block stored in the target note for a structured citation. */
export function citationBlock({
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
  if ((descriptor.level ?? "content") !== "content") return [current];
  return [current, legacyContentBlock(descriptor)];
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
  const match = matcher.exec(content);
  if (!match) return undefined;
  const start = match.index + match[1].length;
  return {
    start,
    end: start + match[2].length,
    value: match[2],
  };
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

/** Append once so repeated clicks cannot duplicate the same citation block. */
export function appendCitationBlock(
  content: string,
  descriptor: CitationDescriptor
): string {
  const block = citationBlock(descriptor);
  const current = content.trimEnd();
  if (
    citationBlockVariants(descriptor).some(item =>
      findCitationBlock(current, item)
    )
  )
    return content;
  return current ? `${current}\n\n${block}\n` : `${block}\n`;
}

/** Remove one matching generated block while preserving the surrounding note. */
export function removeCitationBlock(
  content: string,
  descriptor: CitationDescriptor
): string {
  const match = citationBlockVariants(descriptor)
    .map(block => findCitationBlock(content, block))
    .find((item): item is BlockRange => item !== undefined);
  if (!match) return content;

  const before = content.slice(0, match.start).trimEnd();
  const after = content.slice(match.end).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

/** Remove all supplied structured citations from one note. */
export function removeCitationBlocks(
  content: string,
  descriptors: CitationDescriptor[]
): string {
  return descriptors.reduce(removeCitationBlock, content);
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
  const replacement = citationBlockVariants({
    ...descriptor,
    bookTitle: nextBookTitle,
  });
  return previous.reduce(
    (next, block, index) =>
      replaceGeneratedBlock(next, block, replacement[index]),
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
