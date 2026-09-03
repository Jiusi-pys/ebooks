import type { Book, MindMap, MindNode } from '@/types';
import { uid } from './db';

export interface LayoutMindNode {
  node: MindNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  childCount: number;
}

export interface MindLayout {
  nodes: LayoutMindNode[];
  links: { from: LayoutMindNode; to: LayoutMindNode; path: string }[];
  width: number;
  height: number;
}

export function newNode(text: string, chapterId?: string): MindNode {
  return { id: uid(), text, chapterId, children: [] };
}

/** 从书籍目录生成初始脑图：书 → 章节 → 段落线索（默认折叠，保持总览清爽） */
export function createMindFromBook(book: Book): MindMap {
  const now = Date.now();
  return {
    id: uid(),
    title: `${book.title} 脑图`,
    bookId: book.id,
    createdAt: now,
    updatedAt: now,
    root: {
      id: uid(),
      text: book.title,
      children: book.chapters.map((c, i) => ({
        id: uid(),
        text: `${String(i + 1).padStart(2, '0')} ${c.title}`,
        chapterId: c.id,
        collapsed: c.paragraphs.length > 1,
        children: c.paragraphs.slice(0, 3).map((p, j) => {
          const clean = p.trim().replace(/\s+/g, ' ');
          return {
            id: uid(),
            text: clean.length > 26 ? clean.slice(0, 26) + '…' : clean || `段落 ${j + 1}`,
            children: [],
          };
        }),
      })),
    },
  };
}

export function countNodes(node: MindNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

export function findNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function findParent(root: MindNode, id: string): MindNode | null {
  for (const child of root.children) {
    if (child.id === id) return root;
    const hit = findParent(child, id);
    if (hit) return hit;
  }
  return null;
}

function mapTree(node: MindNode, fn: (n: MindNode) => MindNode): MindNode {
  const next = fn({ ...node, children: node.children.map((c) => mapTree(c, fn)) });
  return next;
}

export function updateNode(root: MindNode, id: string, patch: Partial<MindNode>): MindNode {
  return mapTree(root, (n) => (n.id === id ? { ...n, ...patch } : n));
}

export function appendChild(root: MindNode, parentId: string, child: MindNode): MindNode {
  return mapTree(root, (n) =>
    n.id === parentId ? { ...n, collapsed: false, children: [...n.children, child] } : n,
  );
}

export function appendSibling(root: MindNode, id: string, sibling: MindNode): MindNode {
  const parent = findParent(root, id);
  if (!parent) return root;
  const index = parent.children.findIndex((c) => c.id === id);
  const nextChildren = [...parent.children];
  nextChildren.splice(index + 1, 0, sibling);
  return updateNode(root, parent.id, { children: nextChildren });
}

export function removeNode(root: MindNode, id: string): MindNode {
  const parent = findParent(root, id);
  if (!parent) return root;
  return updateNode(root, parent.id, { children: parent.children.filter((c) => c.id !== id) });
}

function nodeSize(node: MindNode, depth: number) {
  const len = Array.from(node.text).length;
  if (depth === 0) return { w: Math.min(220, Math.max(140, len * 15 + 34)), h: 48 };
  if (depth === 1) return { w: Math.min(190, Math.max(126, len * 13 + 28)), h: 40 };
  return { w: Math.min(180, Math.max(112, len * 12 + 24)), h: 34 };
}

/** 横向树布局：父节点垂直居中于可见子树，折叠节点只显示 +N */
export function layoutMind(root: MindNode): MindLayout {
  const nodes: LayoutMindNode[] = [];
  const links: MindLayout['links'] = [];
  const rowGap = 18;
  const colGap = 86;
  let cursorY = 44;
  let maxDepth = 0;

  const visit = (node: MindNode, depth: number): LayoutMindNode => {
    const size = nodeSize(node, depth);
    const visible = node.collapsed ? [] : node.children;
    maxDepth = Math.max(maxDepth, depth);
    let y: number;
    const laidChildren: LayoutMindNode[] = [];
    if (visible.length) {
      for (const child of visible) laidChildren.push(visit(child, depth + 1));
      y = (laidChildren[0].y + laidChildren[laidChildren.length - 1].y) / 2;
    } else {
      y = cursorY + size.h / 2;
      cursorY += size.h + rowGap;
    }
    const laid: LayoutMindNode = {
      node,
      x: 48 + depth * (180 + colGap),
      y,
      w: size.w,
      h: size.h,
      depth,
      childCount: countNodes(node) - 1,
    };
    nodes.push(laid);
    for (const child of laidChildren) {
      const x1 = laid.x + laid.w;
      const y1 = laid.y;
      const x2 = child.x;
      const y2 = child.y;
      const mid = (x1 + x2) / 2;
      links.push({
        from: laid,
        to: child,
        path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
      });
    }
    return laid;
  };

  visit(root, 0);
  return {
    nodes,
    links,
    width: 96 + (maxDepth + 1) * 266,
    height: Math.max(300, cursorY + 44),
  };
}
