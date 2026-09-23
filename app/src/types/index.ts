export interface EpubFootnote {
  paraIndex: number;
  /** UTF-16 offsets into the normalized paragraph; no HTML is stored. */
  start: number;
  end: number;
  content: string;
}

export interface Chapter {
  id: string;
  title: string;
  /** 已按段落重排后的正文 */
  paragraphs: string[];
  footnotes?: EpubFootnote[];
}

export type BookContributorRole =
  "author" | "editor" | "translator" | "illustrator" | "other";

export interface BookContributor {
  name: string;
  role: BookContributorRole;
}

export interface BookIdentifier {
  /** Common schemes include ISBN, DOI, ASIN and UUID. */
  scheme: string;
  value: string;
}

/**
 * Editable catalogue metadata. This updates the library record and MySQL
 * mirror; it does not rewrite the original EPUB/PDF/MOBI file.
 */
export interface BookMetadata {
  version: 1;
  subtitle?: string;
  contributors?: BookContributor[];
  publisher?: string;
  /** Precision-preserving ISO date: YYYY, YYYY-MM or YYYY-MM-DD. */
  publishedDate?: string;
  /** BCP 47 language tags, in display priority order. */
  languages?: string[];
  identifiers?: BookIdentifier[];
  series?: string;
  seriesIndex?: number;
  subjects?: string[];
  description?: string;
  edition?: string;
  rights?: string;
  /** Personal library rating, from 0 to 5. */
  rating?: number;
}

export type BookFormat =
  "pdf" | "epub" | "mobi" | "azw3" | "fb2" | "txt" | "builtin";

/** 可编辑导航目录。扁平顺序配合 depth 表达层级，章节与正文锚点均可独立编排。 */
export interface OutlineItem {
  id: string;
  title: string;
  /** 缺省时为不跳转的分组标题。 */
  chapterId?: string;
  /** 精确跳转到重排正文的段落；缺省时跳到章节顶部。 */
  paraIndex?: number;
  depth: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  /** dataURL 封面缩略图 */
  cover?: string;
  /** 用户覆盖的自定义封面；清除后继续使用书籍内置封面。 */
  customCover?: string;
  /** 无封面时使用的确定性配色索引 */
  coverTone: number;
  chapters: Chapter[];
  createdAt: number;
  /** Most recent time the reader was opened; separate from publication data. */
  lastOpenedAt?: number;
  /** Optional extended catalogue metadata; title/author stay top-level for compatibility. */
  metadata?: BookMetadata;
  /** 阅读进度 */
  progress: { chapterId: string; ratio: number };
  /** 正文内容哈希（用于 AI 全书导读缓存） */
  contentHash?: string;
  /** 所属文件夹 id；缺省 = 未分类 */
  folderId?: string;
  /**
   * 阅读模式：重排文本 / 原版 PDF 版面（仅 PDF 有效；其他格式均为 reflow）。
   * 如同汉王阅读器：每个文件可自行选择是否重排，版式复杂的 PDF 适合原版。
   */
  readerMode?: "reflow" | "original";
  /** 本书专用的阅读排版；缺省时继承通用排版。 */
  typeSettings?: TypeSettings;
  /** 原版 PDF 页数 */
  pageCount?: number;
  /** 用户自定义导航目录；缺省时由 chapters 自动生成。 */
  outline?: OutlineItem[];
}

export type FolderIconKey =
  | "folder"
  | "library"
  | "study"
  | "archive"
  | "work"
  | "heart"
  | "sparkles"
  | "bookmark";

/** 书架分类文件夹 */
export interface Folder {
  id: string;
  name: string;
  /** 书架展示图标；旧数据缺省时使用 folder。 */
  icon?: FolderIconKey;
  createdAt: number;
}

/** 独立的逻辑学习集合；与书架文件夹无关，同一本书可属于多个学习集。 */
export interface StudySet {
  id: string;
  name: string;
  description?: string;
  bookIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  title: string;
  /** markdown-lite 文本，支持 [[双链]] */
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** 划线样式：下划线 / 背景色 / 字色 / 仅锚点（AI 问答用，不可见） */
export type HighlightKind = "underline" | "background" | "color" | "none";

export interface HighlightStyle {
  kind: HighlightKind;
  /** 预设色键：orange | yellow | green | blue | purple */
  color: string;
}

/** PDF 页内的归一化矩形；四个值均相对于当前页可视区域。 */
export interface PdfAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 原版 PDF 书摘的稳定页内定位信息。 */
export interface PdfHighlightAnchor {
  /** PDF 页码，从 1 开始。 */
  page: number;
  /** 多行选区会保存多个矩形。 */
  rects: PdfAnchorRect[];
}

/** 可排版正文中的精确文段锚点。 */
export interface TextPassageAnchor {
  kind: "text";
  bookId: string;
  chapterId: string;
  chapterTitle: string;
  text: string;
  paraIndex: number;
  start: number;
  end: number;
}

/** 原版 PDF 中的精确文段锚点。 */
export interface PdfPassageAnchor {
  kind: "pdf";
  bookId: string;
  chapterId: string;
  chapterTitle: string;
  text: string;
  pdfAnchor: PdfHighlightAnchor;
}

/** “关联”两端均使用的稳定来源描述；与书摘、引用和笔记相互独立。 */
export type PassageAnchor = TextPassageAnchor | PdfPassageAnchor;

export type AssociationDirection = "bidirectional" | "source-to-target";

/** 两个精确文段之间的独立关系。 */
export interface Association {
  id: string;
  source: PassageAnchor;
  target: PassageAnchor;
  direction: AssociationDirection;
  /** 可选的关系名称，例如“相似观点”或“反例”。 */
  label?: string;
  /** 不受标题或正文快照影响的去重键。 */
  pairKey: string;
  createdAt: number;
  updatedAt: number;
}

/** 引用来源层级：整本书、章节，或章节中的具体内容。 */
export type CitationLevel = "book" | "chapter" | "content";

/**
 * 引用的结构化来源锚点。书籍级只保存 level；章节级再保存 chapterId；
 * 内容级继续保存段落/字符或 PDF 几何位置，便于精确跳回原文。
 */
export interface CitationAnchor {
  level: CitationLevel;
  chapterId?: string;
  paraIndex?: number;
  start?: number;
  end?: number;
  pdfAnchor?: PdfHighlightAnchor;
}

export interface AiQA {
  q: string;
  a: string;
  ts: number;
}

export type AiProviderId = "codex" | "deepseek";
export type AiEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** 浏览器端选择的全局 AI 后端；apiKey 只保存在当前浏览器会话。 */
export interface AiConfig {
  provider: AiProviderId;
  model: string;
  effort: AiEffort;
  apiKey?: string;
}

/** 间隔重复状态（简化 FSRS/SM-2）：加入复习后存在 */
export interface ReviewState {
  /** 下次到期时间戳 */
  due: number;
  /** 连续答对次数 */
  reps: number;
  /** 失败次数 */
  lapses: number;
  /** 当前间隔（天） */
  interval: number;
  /** 上次评分 1-4 */
  lastRating?: 1 | 2 | 3 | 4;
  lastReviewedAt?: number;
  /** 加入复习的时间 */
  addedAt: number;
}

export interface Highlight {
  id: string;
  bookId: string;
  chapterId: string;
  chapterTitle: string;
  text: string;
  /** 段落内定位（新版）；旧数据缺省时按文本回退匹配 */
  paraIndex?: number;
  start?: number;
  end?: number;
  /** 原版 PDF 中的页码与页内几何锚点。 */
  pdfAnchor?: PdfHighlightAnchor;
  style?: HighlightStyle;
  /** 批注/书摘的自定义名称（可选，便于引用时辨认） */
  name?: string;
  /** 内联批注内容（Notion comment 式） */
  note?: string;
  /** 被引用到的笔记 id（可选） */
  noteId?: string;
  /** 引用层级及定位；旧数据缺省时按内容级引用兼容。 */
  citation?: CitationAnchor;
  /** 针对该文段的 AI 问答记录 */
  aiQa?: AiQA[];
  /** 卡片标签（卡片盒筛选 / 自动组脑图） */
  tags?: string[];
  /** 挖空项：复习/回忆模式下被遮挡的词或短语 */
  cloze?: string[];
  /** 间隔重复复习状态；undefined = 未加入复习 */
  review?: ReviewState;
  createdAt: number;
}

/** 章节译文缓存（本地保存，避免重复消耗模型调用） */
export interface ChapterTranslation {
  id: string;
  bookId: string;
  chapterId: string;
  targetLang: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** 可编辑脑图节点；chapterId 用于从节点跳回阅读位置 */
export interface MindNode {
  id: string;
  text: string;
  children: MindNode[];
  chapterId?: string;
  /** 同一知识卡在脑图中的来源；用于跳回原文摘录。 */
  sourceHighlightId?: string;
  collapsed?: boolean;
}

export interface MindMap {
  id: string;
  title: string;
  bookId?: string;
  root: MindNode;
  createdAt: number;
  updatedAt: number;
}

export type ViewName =
  | "library"
  | "reader"
  | "notes"
  | "note"
  | "graph"
  | "highlights"
  | "mind"
  | "review"
  | "studyset";

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

export interface TypeSettings {
  fontId: string;
  fontSize: number; // px
  lineHeight: number; // 1.4 - 2.6
  paragraphSpacing: number; // em, 0 - 3
  letterSpacing: number; // em, 0 - 0.12
  pageMargin: number; // px, text distance from the reading-page edge
  fontWeight: 300 | 400 | 600;
  columns: 1 | 2;
  /** 重排正文的阅读方式：纵向连续滚动或横向逐页翻阅。 */
  pageTurnMode: "vertical" | "horizontal" | "curl";
  themeId: string;
}

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
