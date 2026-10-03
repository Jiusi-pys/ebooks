export * from "@contracts/domain";
import type { PassageAnchor } from "@contracts/domain";

export type ViewName =
  | "library"
  | "reader"
  | "notes"
  | "note"
  | "graph"
  | "highlights"
  | "mind"
  | "review"
  | "studyset"
  | "readingHistory";

export interface Route {
  view: ViewName;
  bookId?: string;
  chapterId?: string;
  noteId?: string;
  /** 独立学习集 id */
  studySetId?: string;
  /** 全局搜索打开笔记时选中命中的标题或正文文字。 */
  searchNoteRange?: { field: "title" | "content"; start: number; end: number };
  /** 跳转后需要滚动定位并闪烁的书摘 */
  highlightId?: string;
  /** 原版 PDF 模式下用于定位的锚点文字（书摘 text） */
  anchorText?: string;
  /** 从关联面板或图谱跳回的精确文段锚点。 */
  passageAnchor?: PassageAnchor;
  /** 自定义目录的段落级跳转目标。 */
  outlineParaIndex?: number;
  /** 允许连续点击同一目录项时也重新执行定位。 */
  outlineNavigationKey?: number;
}

/* ---------- 阅读排版设置 ---------- */

export interface ReaderFont {
  id: string;
  name: string;
  stack: string;
}

export interface ReaderTheme {
  id: string;
  name: string;
  bg: string;
  panel: string;
  text: string;
  muted: string;
  border: string;
  /** 划选区配色 */
  selection: string;
}
