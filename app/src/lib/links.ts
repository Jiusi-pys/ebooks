import type { Book, Highlight, Note } from '@/types';

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
export function computeBacklinks(targetTitle: string, notes: Note[], excludeNoteId?: string): Backlink[] {
  const result: Backlink[] = [];
  const needle = targetTitle.trim().toLowerCase();
  for (const note of notes) {
    if (note.id === excludeNoteId) continue;
    const links = extractLinks(note.content);
    if (!links.some((l) => l.toLowerCase() === needle)) continue;
    // 找第一处出现位置做摘录
    const lines = note.content.split('\n');
    const hit = lines.find((ln) => ln.toLowerCase().includes(`[[${needle}]]`)) ?? lines[0] ?? '';
    result.push({ noteId: note.id, noteTitle: note.title, excerpt: hit.trim().slice(0, 80) });
  }
  return result;
}

export interface GraphNode {
  id: string;
  kind: 'book' | 'note';
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

/** 由书籍 + 笔记 + 书摘关系构建图谱数据 */
export function buildGraph(books: Book[], notes: Note[], highlights: Highlight[]) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();

  const addNode = (n: GraphNode) => {
    if (!nodeIds.has(n.id)) {
      nodeIds.add(n.id);
      nodes.push(n);
    }
  };
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    const key = [a, b].sort().join('~');
    if (!edgeKeys.has(key) && nodeIds.has(a) && nodeIds.has(b)) {
      edgeKeys.add(key);
      edges.push({ source: a, target: b });
    }
  };

  for (const b of books) addNode({ id: `book:${b.id}`, kind: 'book', label: b.title });
  for (const n of notes) addNode({ id: `note:${n.id}`, kind: 'note', label: n.title });

  const titleIndex = new Map<string, string>(); // lower-title -> node id
  for (const b of books) titleIndex.set(b.title.toLowerCase(), `book:${b.id}`);
  for (const n of notes) titleIndex.set(n.title.toLowerCase(), `note:${n.id}`);

  for (const n of notes) {
    for (const link of extractLinks(n.content)) {
      const target = titleIndex.get(link.toLowerCase());
      if (target) addEdge(`note:${n.id}`, target);
    }
  }
  for (const h of highlights) {
    if (h.noteId) addEdge(`note:${h.noteId}`, `book:${h.bookId}`);
  }
  return { nodes, edges };
}
