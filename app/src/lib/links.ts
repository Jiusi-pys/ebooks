import type {
  Association,
  Book,
  Highlight,
  Note,
  PassageAnchor,
} from "@/types";
import { citationLevelOf } from "./citations";
import { passageAnchorFromHighlight, passageAnchorKey } from "./associations";

/** 从文本中提取 [[双链]] 目标 */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]\n]{1,60})\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[1].trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export interface Backlink {
  noteId: string;
  noteTitle: string;
  /** 命中所在行的上下文摘录 */
  excerpt: string;
}

/** 计算指向某个标题（笔记标题或书名）的全部反链 */
export function computeBacklinks(
  targetTitle: string,
  notes: Note[],
  excludeNoteId?: string
): Backlink[] {
  const result: Backlink[] = [];
  const needle = targetTitle.trim().toLowerCase();
  for (const note of notes) {
    if (note.id === excludeNoteId) continue;
    const links = extractLinks(note.content);
    if (!links.some(l => l.toLowerCase() === needle)) continue;
    // 找第一处出现位置做摘录
    const lines = note.content.split("\n");
    const hit =
      lines.find(ln => ln.toLowerCase().includes(`[[${needle}]]`)) ??
      lines[0] ??
      "";
    result.push({
      noteId: note.id,
      noteTitle: note.title,
      excerpt: hit.trim().slice(0, 80),
    });
  }
  return result;
}

export interface GraphNode {
  id: string;
  kind: "book" | "chapter" | "content" | "note";
  label: string;
  /** 阅读节点的显式路由元数据；不要从可能含冒号的 id 反解析。 */
  bookId?: string;
  chapterId?: string;
  highlightId?: string;
  /** Association-only content nodes navigate with their own exact anchor. */
  anchor?: PassageAnchor;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind?: "association";
  associationId?: string;
  directed?: boolean;
  label?: string;
}

function finiteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/**
 * Build an unambiguous identity for the cited source rather than for the
 * highlight record. JSON tuples avoid delimiter collisions when book or
 * chapter ids themselves contain punctuation; URI encoding keeps the result
 * safe to use as a graph node id.
 */
function legacyContentSourceNodeId(highlight: Highlight): string {
  const citation = highlight.citation;
  const chapterId = citation?.chapterId ?? highlight.chapterId;
  const pdfAnchor = citation?.pdfAnchor ?? highlight.pdfAnchor;

  if (
    pdfAnchor &&
    finiteNumber(pdfAnchor.page) &&
    pdfAnchor.rects.length > 0 &&
    pdfAnchor.rects.every(
      rect =>
        finiteNumber(rect.x) &&
        finiteNumber(rect.y) &&
        finiteNumber(rect.width) &&
        finiteNumber(rect.height)
    )
  ) {
    // Rectangle order is not part of the selected source. Sorting makes the
    // same multi-line PDF selection stable if a renderer reports its rects in
    // a different order, while preserving every exact coordinate.
    const rects = pdfAnchor.rects
      .map(rect => [
        rect.x || 0,
        rect.y || 0,
        rect.width || 0,
        rect.height || 0,
      ])
      .sort((left, right) => {
        for (let index = 0; index < left.length; index += 1) {
          const difference = left[index] - right[index];
          if (difference !== 0) return difference;
        }
        return 0;
      });
    return `content:${encodeURIComponent(
      JSON.stringify(["pdf", highlight.bookId, pdfAnchor.page, rects])
    )}`;
  }

  const paraIndex = citation?.paraIndex ?? highlight.paraIndex;
  const start = citation?.start ?? highlight.start;
  const end = citation?.end ?? highlight.end;
  if (finiteNumber(paraIndex) && finiteNumber(start) && finiteNumber(end)) {
    return `content:${encodeURIComponent(
      JSON.stringify([
        "text",
        highlight.bookId,
        chapterId,
        paraIndex,
        start,
        end,
      ])
    )}`;
  }

  // Old records may only contain chapter/text, or just part of a text anchor.
  // Retaining all known coordinates plus the exact text lets equivalent legacy
  // citations converge without pretending that distinct known locations match.
  return `content:${encodeURIComponent(
    JSON.stringify([
      "legacy",
      highlight.bookId,
      chapterId,
      paraIndex ?? null,
      start ?? null,
      end ?? null,
      highlight.text,
    ])
  )}`;
}

/** Canonical graph identity shared by citations and passage associations. */
export function contentSourceNodeId(anchor: PassageAnchor): string {
  return `content:${passageAnchorKey(anchor)}`;
}

/** 由书籍 + 笔记 + 书摘关系构建图谱数据 */
export function buildGraph(
  books: Book[],
  notes: Note[],
  highlights: Highlight[],
  associations: Association[] = []
) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, GraphNode>();
  const edgeKeys = new Set<string>();

  const addNode = (n: GraphNode) => {
    const existing = nodesById.get(n.id);
    if (existing) {
      if (!existing.highlightId && n.highlightId)
        existing.highlightId = n.highlightId;
      if (!existing.anchor && n.anchor) existing.anchor = n.anchor;
      return;
    }
    nodeIds.add(n.id);
    nodesById.set(n.id, n);
    nodes.push(n);
  };
  const addEdge = (
    a: string,
    b: string,
    metadata?: Omit<GraphEdge, "source" | "target">
  ) => {
    if (a === b) return;
    const key =
      metadata?.kind === "association"
        ? `association:${metadata.associationId ?? ""}:${
            metadata.directed ? `${a}>${b}` : [a, b].sort().join("~")
          }`
        : [a, b].sort().join("~");
    if (!edgeKeys.has(key) && nodeIds.has(a) && nodeIds.has(b)) {
      edgeKeys.add(key);
      edges.push({ source: a, target: b, ...metadata });
    }
  };

  for (const b of books)
    addNode({
      id: `book:${b.id}`,
      kind: "book",
      label: b.title,
      bookId: b.id,
    });
  for (const n of notes)
    addNode({ id: `note:${n.id}`, kind: "note", label: n.title });

  const bookById = new Map(books.map(book => [book.id, book]));

  const ensureContentPath = (
    anchor: PassageAnchor | null,
    fallbackHighlight?: Highlight
  ): string | null => {
    const bookId = anchor?.bookId ?? fallbackHighlight?.bookId;
    const chapterId = anchor?.chapterId ?? fallbackHighlight?.chapterId;
    if (!bookId || !chapterId) return null;
    const sourceBook = bookById.get(bookId);
    const sourceChapter =
      sourceBook?.chapters.find(chapter => chapter.id === chapterId) ??
      (sourceBook?.format === "pdf" &&
      anchor?.kind === "pdf" &&
      chapterId === `pdf-original:${bookId}`
        ? {
            id: chapterId,
            title: "原版 PDF",
            paragraphs: [],
          }
        : undefined);
    if (!sourceBook || !sourceChapter) return null;

    const bookNodeId = `book:${bookId}`;
    const chapterNodeId = `chapter:${bookId}:${chapterId}`;
    addNode({
      id: chapterNodeId,
      kind: "chapter",
      label: sourceChapter.title,
      bookId,
      chapterId,
    });
    addEdge(bookNodeId, chapterNodeId);

    const contentNodeId = anchor
      ? contentSourceNodeId(anchor)
      : fallbackHighlight
        ? legacyContentSourceNodeId(fallbackHighlight)
        : null;
    if (!contentNodeId) return null;
    const label = (anchor?.text ?? fallbackHighlight?.text ?? "")
      .trim()
      .replace(/\s+/g, " ");
    addNode({
      id: contentNodeId,
      kind: "content",
      label: label || "具体内容",
      bookId,
      chapterId,
      highlightId: fallbackHighlight?.id,
      anchor: anchor ?? undefined,
    });
    addEdge(chapterNodeId, contentNodeId);
    return contentNodeId;
  };

  // 结构化的章节/内容引用会在下方形成完整层级路径。其自动生成的
  // [[书名]] 不应再产生 note→book 快捷边，否则图谱看起来仍只有书籍级。
  const hierarchicalBookLinks = new Map<string, Set<string>>();
  for (const highlight of highlights) {
    if (!highlight.noteId || citationLevelOf(highlight) === "book") continue;
    const sourceBook = bookById.get(highlight.bookId);
    const validChapter = sourceBook?.chapters.some(
      chapter => chapter.id === highlight.chapterId
    );
    if (!validChapter) continue;
    const ids =
      hierarchicalBookLinks.get(highlight.noteId) ?? new Set<string>();
    ids.add(highlight.bookId);
    hierarchicalBookLinks.set(highlight.noteId, ids);
  }

  const titleIndex = new Map<string, string>(); // lower-title -> node id
  for (const b of books) titleIndex.set(b.title.toLowerCase(), `book:${b.id}`);
  for (const n of notes) titleIndex.set(n.title.toLowerCase(), `note:${n.id}`);

  for (const n of notes) {
    for (const link of extractLinks(n.content)) {
      const target = titleIndex.get(link.toLowerCase());
      if (
        target?.startsWith("book:") &&
        hierarchicalBookLinks.get(n.id)?.has(target.slice("book:".length))
      )
        continue;
      if (target) addEdge(`note:${n.id}`, target);
    }
  }

  for (const h of highlights) {
    if (!h.noteId || !nodeIds.has(`note:${h.noteId}`)) continue;
    const sourceBook = bookById.get(h.bookId);
    if (!sourceBook) continue;

    const noteNodeId = `note:${h.noteId}`;
    const bookNodeId = `book:${h.bookId}`;
    const level = citationLevelOf(h);
    if (level === "book") {
      addEdge(noteNodeId, bookNodeId);
      continue;
    }

    const sourceChapter = sourceBook.chapters.find(
      chapter => chapter.id === h.chapterId
    );
    // 损坏或旧版不完整锚点降级到书籍关系，绝不生成孤立层级节点。
    if (!sourceChapter) {
      addEdge(noteNodeId, bookNodeId);
      continue;
    }

    const chapterNodeId = `chapter:${h.bookId}:${sourceChapter.id}`;
    addNode({
      id: chapterNodeId,
      kind: "chapter",
      label: sourceChapter.title,
      bookId: h.bookId,
      chapterId: sourceChapter.id,
    });
    addEdge(bookNodeId, chapterNodeId);
    if (level === "chapter") {
      addEdge(noteNodeId, chapterNodeId);
      continue;
    }

    const contentNodeId = ensureContentPath(passageAnchorFromHighlight(h), h);
    if (contentNodeId) addEdge(noteNodeId, contentNodeId);
  }

  for (const association of associations) {
    const sourceNodeId = ensureContentPath(association.source);
    const targetNodeId = ensureContentPath(association.target);
    if (!sourceNodeId || !targetNodeId) continue;
    addEdge(sourceNodeId, targetNodeId, {
      kind: "association",
      associationId: association.id,
      directed: association.direction === "source-to-target",
      label: association.label,
    });
  }
  return { nodes, edges };
}
