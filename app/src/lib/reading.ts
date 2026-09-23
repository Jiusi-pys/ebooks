import type {
  Book,
  Chapter,
  Highlight,
  ReaderFont,
  ReaderTheme,
  TypeSettings,
} from "@/types";

/* ---------- 可选字体（尽量覆盖各平台中文字体族） ---------- */

export const READER_FONTS: ReaderFont[] = [
  {
    id: "song",
    name: "宋体",
    stack:
      '"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif',
  },
  {
    id: "hei",
    name: "黑体",
    stack:
      '"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC",sans-serif',
  },
  {
    id: "kai",
    name: "楷体",
    stack: '"LXGW WenKai","Kaiti SC","KaiTi","STKaiti","BiauKai",serif',
  },
  {
    id: "fangsong",
    name: "仿宋",
    stack: '"STFangsong","FangSong","FangSong_GB2312","Noto Serif SC",serif',
  },
  {
    id: "yuan",
    name: "圆体",
    stack:
      '"Yuanti SC","YouYuan","Arial Rounded MT Bold","PingFang SC",sans-serif',
  },
  {
    id: "xihei",
    name: "细黑",
    stack: '"PingFang SC","Heiti SC","Microsoft YaHei Light",sans-serif',
  },
  {
    id: "latin-serif",
    name: "西文衬线",
    stack: 'Georgia,"Times New Roman","Noto Serif SC","Songti SC",serif',
  },
  {
    id: "latin-sans",
    name: "西文无衬线",
    stack: '"Helvetica Neue",Arial,"Noto Sans SC","PingFang SC",sans-serif',
  },
];

export function fontStack(id: string): string {
  return READER_FONTS.find(f => f.id === id)?.stack ?? READER_FONTS[0].stack;
}

/* ---------- 背景主题（Apple Books 式） ---------- */

export const READER_THEMES: ReaderTheme[] = [
  {
    id: "paper",
    name: "纸白",
    bg: "#fffdf7",
    panel: "#f7f2e8",
    text: "#3d3629",
    muted: "#8a7d6b",
    border: "#e8e0d0",
    selection: "#ffe9b0",
  },
  {
    id: "warm",
    name: "暖米",
    bg: "#f3ecdf",
    panel: "#ece3d2",
    text: "#4f483e",
    muted: "#93866f",
    border: "#ddd2bc",
    selection: "#ffdf9e",
  },
  {
    id: "green",
    name: "豆绿",
    bg: "#e7efe2",
    panel: "#dce7d6",
    text: "#33402f",
    muted: "#71816b",
    border: "#cbd8c2",
    selection: "#cde6b8",
  },
  {
    id: "night",
    name: "夜览",
    bg: "#262019",
    panel: "#2e2820",
    text: "#cfc2a8",
    muted: "#8d8168",
    border: "#453c2d",
    selection: "#4d422a",
  },
];

export function themeById(id: string): ReaderTheme {
  return READER_THEMES.find(t => t.id === id) ?? READER_THEMES[1];
}

export const DEFAULT_TYPE: TypeSettings = {
  fontId: "song",
  fontSize: 19,
  lineHeight: 2.0,
  paragraphSpacing: 0.4,
  letterSpacing: 0.02,
  pageMargin: 32,
  fontWeight: 400,
  columns: 1,
  pageTurnMode: "vertical",
  themeId: "warm",
};

export const PAGE_MARGIN_MIN = 16;
export const PAGE_MARGIN_MAX = 480;
const TYPE_SETTINGS_KEY = "shufang-type2";

interface TypeSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Keep persisted/user-supplied page margins within a usable reading range. */
export function normalizePageMargin(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_TYPE.pageMargin;
  return Math.min(
    PAGE_MARGIN_MAX,
    Math.max(PAGE_MARGIN_MIN, Math.round(value))
  );
}

/** Upgrade older saved settings (which have no pageMargin) without losing the other choices. */
export function normalizeTypeSettings(value: unknown): TypeSettings {
  const saved =
    value && typeof value === "object" ? (value as Partial<TypeSettings>) : {};
  return {
    ...DEFAULT_TYPE,
    ...saved,
    pageMargin: normalizePageMargin(saved.pageMargin),
    paragraphSpacing:
      typeof saved.paragraphSpacing === "number" &&
      Number.isFinite(saved.paragraphSpacing)
        ? Math.min(3, Math.max(0, saved.paragraphSpacing))
        : DEFAULT_TYPE.paragraphSpacing,
    pageTurnMode:
      saved.pageTurnMode === "horizontal" || saved.pageTurnMode === "curl"
        ? saved.pageTurnMode
        : "vertical",
  };
}

/** A book override takes precedence; books without one inherit the global default. */
export function resolveTypeSettings(
  general: TypeSettings,
  bookSpecific?: TypeSettings
): TypeSettings {
  return bookSpecific ?? general;
}

/** Responsive padding: honour the preference while retaining room in narrow split panes. */
export function readerPagePadding(pageMargin: number): string {
  return `clamp(${PAGE_MARGIN_MIN}px, ${normalizePageMargin(pageMargin)}px, 25%)`;
}

/** Horizontal and curled modes share the same stable column pagination. */
export function isPagedReaderMode(mode: TypeSettings["pageTurnMode"]): boolean {
  return mode === "horizontal" || mode === "curl";
}

/** Keep the 304px selection menu clear of the reader pane's side edges. */
export function clampSelectionToolbarLeft(
  requestedLeft: number,
  paneWidth: number,
  toolbarWidth = 304,
  gutter = 12
): number {
  const half = toolbarWidth / 2 + gutter;
  const upper = Math.max(half, paneWidth - half);
  return Math.min(upper, Math.max(half, requestedLeft));
}

export interface ReaderChapterEntryPlan {
  /** Position to apply after the chapter DOM has completed layout. */
  ratio: number;
  /** Whether entering this chapter represents an explicit navigation. */
  persist: boolean;
}

/**
 * Reopening a book resumes its saved intra-chapter position. Moving to a
 * chapter explicitly (or changing chapter in an already mounted reader)
 * starts that chapter at the top and persists the reset.
 */
export function planReaderChapterEntry(
  previousChapterId: string | null,
  chapterId: string,
  savedProgress: Book["progress"],
  explicitInitialTarget: boolean
): ReaderChapterEntryPlan {
  const isInitialEntry = previousChapterId === null;
  if (
    isInitialEntry &&
    !explicitInitialTarget &&
    savedProgress.chapterId === chapterId
  ) {
    return {
      ratio: Number.isFinite(savedProgress.ratio)
        ? Math.min(1, Math.max(0, savedProgress.ratio))
        : 0,
      persist: false,
    };
  }
  return { ratio: 0, persist: true };
}

export function loadTypeSettings(
  storage: Pick<TypeSettingsStorage, "getItem"> = localStorage
): TypeSettings {
  try {
    return normalizeTypeSettings(
      JSON.parse(storage.getItem(TYPE_SETTINGS_KEY) ?? "{}")
    );
  } catch {
    return { ...DEFAULT_TYPE };
  }
}

export function saveTypeSettings(
  t: TypeSettings,
  storage: Pick<TypeSettingsStorage, "setItem"> = localStorage
) {
  storage.setItem(TYPE_SETTINGS_KEY, JSON.stringify(normalizeTypeSettings(t)));
}

export interface ReaderScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export interface HorizontalReaderPageState {
  page: number;
  pageCount: number;
  atStart: boolean;
  atEnd: boolean;
}

/** Return a stable 0..1 chapter progress for either reflow layout. */
export function readerScrollRatio(
  metrics: ReaderScrollMetrics,
  mode: TypeSettings["pageTurnMode"]
): number {
  const maximum =
    mode === "horizontal"
      ? Math.max(0, metrics.scrollWidth - metrics.clientWidth)
      : Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  if (maximum === 0) return 1;
  const offset = mode === "horizontal" ? metrics.scrollLeft : metrics.scrollTop;
  return Math.min(1, Math.max(0, offset / maximum));
}

/** Convert persisted chapter progress back into the active scroll axis. */
export function readerScrollOffset(
  metrics: ReaderScrollMetrics,
  mode: TypeSettings["pageTurnMode"],
  ratio: number
): number {
  const maximum =
    mode === "horizontal"
      ? Math.max(0, metrics.scrollWidth - metrics.clientWidth)
      : Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const normalized = Number.isFinite(ratio)
    ? Math.min(1, Math.max(0, ratio))
    : 0;
  return maximum * normalized;
}

/** Derive the visible horizontal screen number, including a partial last page. */
export function horizontalReaderPageState(
  metrics: ReaderScrollMetrics
): HorizontalReaderPageState {
  const pageWidth = Math.max(1, metrics.clientWidth);
  const maximum = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const offset = Math.min(maximum, Math.max(0, metrics.scrollLeft));
  const pageCount = Math.max(1, Math.ceil(maximum / pageWidth) + 1);
  const page = Math.min(pageCount, Math.round(offset / pageWidth) + 1);
  const epsilon = Math.max(2, pageWidth * 0.01);
  return {
    page,
    pageCount,
    atStart: offset <= epsilon,
    atEnd: maximum - offset <= epsilon,
  };
}

/* ---------- 划线配色 ---------- */

export interface SwatchColor {
  id: string;
  name: string;
  /** 下划线/字色用的主色 */
  solid: string;
  /** 背景色用的浅色 */
  soft: string;
}

export const SWATCH_COLORS: SwatchColor[] = [
  { id: "orange", name: "橙", solid: "#f54001", soft: "rgba(245,64,1,0.16)" },
  { id: "yellow", name: "黄", solid: "#c99908", soft: "rgba(255,193,60,0.35)" },
  { id: "green", name: "绿", solid: "#4f7a3a", soft: "rgba(122,168,92,0.30)" },
  { id: "blue", name: "蓝", solid: "#3a6a9e", soft: "rgba(96,148,196,0.28)" },
  {
    id: "purple",
    name: "紫",
    solid: "#7a5a9e",
    soft: "rgba(150,116,190,0.26)",
  },
];

export function swatch(id: string): SwatchColor {
  return SWATCH_COLORS.find(c => c.id === id) ?? SWATCH_COLORS[0];
}

/* ---------- 书摘定位与渲染分段 ---------- */

export interface LocatedRange {
  paraIndex: number;
  start: number;
  end: number;
}

/** 解析书摘在章节中的位置：优先用存储的偏移，否则按文本回退匹配 */
export function locateHighlight(
  chapter: Chapter,
  h: Highlight
): LocatedRange | null {
  if (
    h.paraIndex !== undefined &&
    h.start !== undefined &&
    h.end !== undefined &&
    chapter.paragraphs[h.paraIndex] !== undefined &&
    chapter.paragraphs[h.paraIndex].slice(h.start, h.end) === h.text
  ) {
    return { paraIndex: h.paraIndex, start: h.start, end: h.end };
  }
  for (let i = 0; i < chapter.paragraphs.length; i++) {
    const idx = chapter.paragraphs[i].indexOf(h.text);
    if (idx >= 0) return { paraIndex: i, start: idx, end: idx + h.text.length };
  }
  return null;
}

export interface Segment {
  text: string;
  highlight?: Highlight;
}

/** 把段落文本按书摘切成分段（支持同段多条，重叠时先到先得） */
export function segmentParagraph(
  text: string,
  ranges: { h: Highlight; start: number; end: number }[]
): Segment[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const segs: Segment[] = [];
  let cur = 0;
  for (const r of sorted) {
    if (r.start < cur) continue; // 重叠跳过
    if (r.start > cur) segs.push({ text: text.slice(cur, r.start) });
    segs.push({ text: text.slice(r.start, r.end), highlight: r.h });
    cur = r.end;
  }
  if (cur < text.length) segs.push({ text: text.slice(cur) });
  return segs;
}

/* ---------- 全书结构扫描（本地） ---------- */

export interface BookStructure {
  title: string;
  author: string;
  chapterCount: number;
  totalChars: number;
  chapters: { title: string; chars: number; opening: string }[];
}

export function scanBookStructure(book: Book): BookStructure {
  const chapters = book.chapters.map(c => {
    const text = c.paragraphs.join("\n");
    return {
      title: c.title,
      chars: text.length,
      opening: c.paragraphs.slice(0, 2).join(" ").slice(0, 120),
    };
  });
  return {
    title: book.title,
    author: book.author,
    chapterCount: chapters.length,
    totalChars: chapters.reduce((s, c) => s + c.chars, 0),
    chapters,
  };
}

export async function contentHashOfBook(book: Book): Promise<string> {
  // Versioned content identity: editable catalogue fields must not fork the
  // digest cache for unchanged book contents.
  const raw = JSON.stringify({
    version: 1,
    format: book.format,
    chapters: book.chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      paragraphs: chapter.paragraphs,
    })),
  });
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ---------- 引用进笔记 ---------- */

export function quoteBlock(
  bookTitle: string,
  chapterTitle: string,
  text: string
): string {
  return `> ${text}\n\n—— [[${bookTitle}]] · ${chapterTitle}\n\n`;
}
