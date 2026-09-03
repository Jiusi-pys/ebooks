import type { Chapter } from "@/types";
import { uid } from "./db";
import { normalizeParagraph } from "./reflow";

const MAX_SPINE_ITEMS = 2_000;
const MAX_CHAPTER_HTML_LENGTH = 8_000_000;
const MAX_BOOK_TEXT_LENGTH = 24_000_000;
const MAX_OUTPUT_CHAPTERS = 4_000;

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TD",
  "TH",
  "TR",
]);
const IGNORED_TAGS = new Set([
  "AUDIO",
  "CANVAS",
  "EMBED",
  "IFRAME",
  "LINK",
  "META",
  "NOSCRIPT",
  "OBJECT",
  "SCRIPT",
  "SOURCE",
  "STYLE",
  "SVG",
  "TEMPLATE",
  "VIDEO",
]);

interface TocItem {
  label: string;
  href: string;
  children?: TocItem[];
}

export interface HtmlBookParser {
  getSpine(): { id: string }[];
  loadChapter(id: string): { html: string } | undefined;
  getToc(): TocItem[];
  resolveHref(href: string): { id: string; selector?: string } | undefined;
}

interface TextBlock {
  heading: number;
  text: string;
}

function cleanText(value: string): string {
  const withoutControls = value.replace(/\p{Cc}/gu, character =>
    character === "\n" || character === "\r" || character === "\t" ? " " : ""
  );
  return normalizeParagraph(withoutControls);
}

/**
 * Parse third-party chapter markup in an inert document and retain text only.
 * The resulting DOM is never attached to the application document, and tags
 * that could contain executable or externally loaded content are ignored.
 */
function collectTextBlocks(html: string): TextBlock[] {
  if (html.length > MAX_CHAPTER_HTML_LENGTH) {
    throw new Error("单个章节内容过大，已停止导入");
  }

  const document = new DOMParser().parseFromString(html, "text/html");
  const blocks: TextBlock[] = [];
  let pending = "";

  const flush = () => {
    const text = cleanText(pending);
    if (text && blocks.at(-1)?.text !== text) {
      blocks.push({ heading: 0, text });
    }
    pending = "";
  };

  const append = (value: string) => {
    pending += value;
  };

  const visibleText = (element: Element): string => {
    let value = "";
    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        value += node.nodeValue ?? "";
        return;
      }
      if (
        !(node instanceof Element) ||
        IGNORED_TAGS.has(node.tagName.toUpperCase())
      )
        return;
      for (const child of Array.from(node.childNodes)) visit(child);
    };
    visit(element);
    return cleanText(value);
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.nodeValue ?? "");
      return;
    }
    if (!(node instanceof Element)) return;

    const tag = node.tagName.toUpperCase();
    if (IGNORED_TAGS.has(tag)) return;
    if (HEADING_TAGS.has(tag)) {
      flush();
      const text = visibleText(node);
      if (text) blocks.push({ heading: Number(tag.slice(1)), text });
      return;
    }
    if (tag === "BR" || tag === "HR") {
      flush();
      return;
    }

    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) flush();
  };

  walk(document.body);
  flush();
  return blocks;
}

function tocTitlesBySpine(parser: HtmlBookParser): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (items: TocItem[], depth: number) => {
    if (depth > 20) return;
    for (const item of items) {
      const title = cleanText(item.label).slice(0, 300);
      if (title && item.href) {
        try {
          const id = parser.resolveHref(item.href)?.id;
          if (id && !result.has(id)) result.set(id, title);
        } catch {
          // A malformed TOC entry should not make otherwise readable text fail.
        }
      }
      if (item.children?.length) visit(item.children, depth + 1);
    }
  };

  try {
    visit(parser.getToc() ?? [], 0);
  } catch {
    // Some older books have a broken TOC; use headings from the text instead.
  }
  return result;
}

function chaptersFromHtml(
  html: string,
  preferredTitle: string,
  startNumber: number
): Chapter[] {
  const blocks = collectTextBlocks(html);
  if (blocks.length === 0) return [];

  const fallbackTitle = `第 ${startNumber} 节`;
  const chapters: Chapter[] = [];
  let title = preferredTitle || fallbackTitle;
  let paragraphs: string[] = [];

  const flush = () => {
    if (paragraphs.length === 0) return;
    chapters.push({ id: uid(), title, paragraphs });
    paragraphs = [];
  };

  for (const block of blocks) {
    if (block.heading > 0 && block.heading <= 2) {
      if (paragraphs.length > 0) {
        flush();
        title = block.text;
      } else if (!preferredTitle || title === fallbackTitle) {
        title = block.text;
      }
      continue;
    }
    if (paragraphs.at(-1) !== block.text) paragraphs.push(block.text);
  }
  flush();
  return chapters;
}

/** Convert a lingo-reader spine to the repository's text-only chapter model. */
export function extractHtmlBookChapters(
  parser: HtmlBookParser,
  onChapter?: (completed: number, total: number) => void
): Chapter[] {
  const spine = parser.getSpine();
  if (spine.length > MAX_SPINE_ITEMS) {
    throw new Error(`书籍章节数超过 ${MAX_SPINE_ITEMS}，已停止导入`);
  }

  const tocTitles = tocTitlesBySpine(parser);
  const chapters: Chapter[] = [];
  let textLength = 0;

  for (let index = 0; index < spine.length; index += 1) {
    const item = spine[index];
    const loaded = parser.loadChapter(item.id);
    if (loaded?.html) {
      const parsed = chaptersFromHtml(
        loaded.html,
        tocTitles.get(item.id) ?? "",
        chapters.length + 1
      );
      for (const chapter of parsed) {
        textLength += chapter.title.length;
        for (const paragraph of chapter.paragraphs)
          textLength += paragraph.length;
        if (textLength > MAX_BOOK_TEXT_LENGTH) {
          throw new Error("书籍正文超过 2400 万字符，已停止导入");
        }
        chapters.push(chapter);
        if (chapters.length > MAX_OUTPUT_CHAPTERS) {
          throw new Error(
            `识别出的章节数超过 ${MAX_OUTPUT_CHAPTERS}，已停止导入`
          );
        }
      }
    }
    onChapter?.(index + 1, spine.length);
  }

  return chapters;
}

const SAFE_COVER_TYPE = /^image\/(?:avif|bmp|gif|jpe?g|png|webp)(?:;|$)/i;
const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** Persist a parser-owned blob URL before parser.destroy() revokes it. */
export async function coverResourceToDataUrl(
  resource: string
): Promise<string | undefined> {
  if (!resource) return undefined;
  if (resource.startsWith("data:")) {
    return resource.length <= MAX_COVER_BYTES * 1.5 &&
      SAFE_COVER_TYPE.test(resource.slice(5))
      ? resource
      : undefined;
  }
  if (!resource.startsWith("blob:")) return undefined;

  try {
    const response = await fetch(resource);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    if (blob.size > MAX_COVER_BYTES || !SAFE_COVER_TYPE.test(blob.type))
      return undefined;
    return await new Promise<string | undefined>(resolve => {
      const reader = new FileReader();
      reader.onerror = () => resolve(undefined);
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}
