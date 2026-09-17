import type { Chapter, EpubFootnote, OutlineItem } from "@/types";
import { normalizeParagraph } from "./reflow";

const EPUB_NS = "http://www.idpf.org/2007/ops";
const normalize = (value: string) =>
  normalizeParagraph(value.replace(/\s+/g, " "));
const tag = (el: Element) => el.localName.toLowerCase();
const semantics = (el: Element) =>
  (
    el.getAttributeNS(EPUB_NS, "type") ??
    el.getAttribute("epub:type") ??
    ""
  ).split(/\s+/);
const isNote = (el: Element) =>
  semantics(el).some(t => t === "footnote" || t === "endnote") ||
  ["doc-footnote", "doc-endnote"].includes(el.getAttribute("role") ?? "");
const isRef = (el: Element) =>
  semantics(el).includes("noteref") ||
  el.getAttribute("role") === "doc-noteref";

/** Canonical, decoded archive path plus optional decoded fragment. */
export function epubTarget(base: string, href: string): string | undefined {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(href) ||
    href.startsWith("//") ||
    href.startsWith("/") ||
    href.includes("\\")
  )
    return;
  try {
    const split = href.indexOf("#");
    const path = decodeURIComponent(
      (split < 0 ? href : href.slice(0, split)).split("?")[0]
    );
    const fragment = split < 0 ? "" : decodeURIComponent(href.slice(split + 1));
    const parts = path ? base.split("/").slice(0, -1) : base.split("/");
    if (path)
      for (const part of path.split("/")) {
        if (part === "..") {
          if (!parts.length) return;
          parts.pop();
        } else if (part && part !== ".") parts.push(part);
      }
    return parts.join("/") + (fragment ? `#${fragment}` : "");
  } catch {
    return;
  }
}

export interface EpubTocEntry {
  title: string;
  target?: string;
  depth: number;
}

export function readEpubToc(doc: Document, path: string): EpubTocEntry[] {
  const toc: EpubTocEntry[] = [];
  const nav = Array.from(doc.querySelectorAll("nav")).find(el =>
    semantics(el).includes("toc")
  );
  if (nav) {
    for (const label of Array.from(nav.querySelectorAll("li > a, li > span"))) {
      let depth = -1;
      for (let p = label.parentElement; p && p !== nav; p = p.parentElement)
        if (tag(p) === "ol") depth++;
      toc.push({
        title: (label.textContent ?? "").trim().slice(0, 500),
        target: label.hasAttribute("href")
          ? epubTarget(path, label.getAttribute("href")!)
          : undefined,
        depth: Math.max(0, depth),
      });
    }
  } else {
    for (const point of Array.from(doc.querySelectorAll("navPoint"))) {
      const children = Array.from(point.children);
      const label = children.find(n => tag(n) === "navlabel");
      const content = children.find(n => tag(n) === "content");
      let depth = 0;
      for (let p = point.parentElement; p; p = p.parentElement)
        if (tag(p) === "navpoint") depth++;
      toc.push({
        title: (label?.textContent ?? "").trim().slice(0, 500),
        target: content
          ? epubTarget(path, content.getAttribute("src") ?? "")
          : undefined,
        depth,
      });
    }
  }
  return toc;
}

interface Block {
  heading: number;
  text: string;
  anchors: string[];
  notes: Omit<EpubFootnote, "paraIndex">[];
}

export function parseEpubContent(
  docs: Map<string, Document>,
  spine: string[],
  toc: EpubTocEntry[]
) {
  const notes = new Map<string, string>();
  const ids = new Map<string, Element | null>();
  for (const [path, doc] of docs) {
    for (const el of Array.from(doc.querySelectorAll("[id]"))) {
      const key = `${path}#${el.id}`;
      ids.set(key, ids.has(key) ? null : el);
    }
  }
  // Explicit references can identify legacy note paragraphs without epub:type.
  for (const [path, doc] of docs) {
    for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
      const key = epubTarget(path, a.getAttribute("href")!);
      const dest = key ? ids.get(key) : undefined;
      if (!key || !dest || (!isRef(a) && !isNote(dest)) || notes.has(key))
        continue;
      const clone = dest.cloneNode(true) as Element;
      for (const unwanted of Array.from(
        clone.querySelectorAll("script, style, a")
      )) {
        if (
          tag(unwanted) !== "a" ||
          semantics(unwanted).includes("backlink") ||
          unwanted.getAttribute("role") === "doc-backlink"
        )
          unwanted.remove();
      }
      notes.set(key, normalize(clone.textContent ?? "").slice(0, 20000));
    }
  }
  const chapters: Chapter[] = [];
  const anchors = new Map<string, { chapterId: string; paraIndex: number }>();
  let characterCount = 0;
  for (const path of spine) {
    const doc = docs.get(path);
    const body = doc?.querySelector("body");
    if (!body) continue;
    const blocks: Block[] = [];
    const seenAnchors = new Set<string>();
    const pendingAnchors: string[] = [];
    const walk = (parent: Element) => {
      for (const el of Array.from(parent.children)) {
        if (["script", "style", "svg", "nav"].includes(tag(el)) || isNote(el))
          continue;
        if (el.id && !normalize(el.textContent ?? ""))
          pendingAnchors.push(el.id);
        if (
          /^h[1-6]$/.test(tag(el)) ||
          ["p", "blockquote", "li", "pre", "td"].includes(tag(el))
        ) {
          let raw = "";
          const refs: { start: number; end: number; content: string }[] = [];
          const inline = (node: Node) => {
            if (node.nodeType === 3) {
              raw += node.textContent;
              return;
            }
            if (node.nodeType !== 1) return;
            const child = node as Element;
            if (
              ["script", "style"].includes(tag(child)) ||
              (child !== el && isNote(child))
            )
              return;
            if (tag(child) === "br") {
              raw += " ";
              return;
            }
            const start = raw.length;
            for (const n of Array.from(child.childNodes)) inline(n);
            const key =
              tag(child) === "a"
                ? epubTarget(path, child.getAttribute("href") ?? "")
                : undefined;
            if (key && notes.has(key))
              refs.push({ start, end: raw.length, content: notes.get(key)! });
          };
          inline(el);
          const value = normalize(raw);
          if (!value) continue;
          const anchorIds = [
            ...pendingAnchors.splice(0),
            ...Array.from(el.querySelectorAll("[id]")).map(n => n.id),
          ];
          for (let p: Element | null = el; p; p = p.parentElement)
            if (p.id) anchorIds.push(p.id);
          const unique = anchorIds.filter(id => !seenAnchors.has(id));
          unique.forEach(id => seenAnchors.add(id));
          blocks.push({
            heading: /^h[1-6]$/.test(tag(el)) ? Number(tag(el)[1]) : 0,
            text: value,
            anchors: unique,
            notes: refs
              .map(r => ({
                start: normalize(raw.slice(0, r.start)).length,
                end: normalize(raw.slice(0, r.end)).length,
                content: r.content,
              }))
              .filter(r => r.end > r.start),
          });
          if (blocks.length > 50000)
            throw new Error("单个 EPUB 章节的段落数过多");
        } else walk(el);
      }
    };
    walk(body);
    if (!blocks.length) continue;
    let current: Chapter = {
      id: crypto.randomUUID(),
      title:
        toc.find(t => t.target === path)?.title ||
        `第 ${chapters.length + 1} 节`,
      paragraphs: [],
    };
    const firstChapter = current.id;
    const publish = () => {
      if (current.paragraphs.length) chapters.push(current);
      if (chapters.length > 8000) throw new Error("EPUB 识别出的章节过多");
    };
    for (const block of blocks) {
      if (block.heading > 0 && block.heading <= 2) {
        if (current.paragraphs.length) {
          publish();
          current = {
            id: crypto.randomUUID(),
            title: block.text.slice(0, 500),
            paragraphs: [],
          };
        } else current.title = block.text.slice(0, 500);
      }
      const paraIndex = current.paragraphs.length;
      for (const id of block.anchors) {
        if (ids.get(`${path}#${id}`))
          anchors.set(`${path}#${id}`, { chapterId: current.id, paraIndex });
      }
      if (!(block.heading > 0 && block.heading <= 2)) {
        current.paragraphs.push(block.text);
        if (block.notes.length)
          (current.footnotes ??= []).push(
            ...block.notes.map(note => ({ ...note, paraIndex }))
          );
      }
      characterCount +=
        block.text.length +
        block.notes.reduce((n, note) => n + note.content.length, 0);
      if (characterCount > 24000000)
        throw new Error("EPUB 正文及注释超过 2400 万字符");
    }
    publish();
    if (chapters.some(c => c.id === firstChapter))
      anchors.set(path, { chapterId: firstChapter, paraIndex: 0 });
  }
  const byId = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const outline: OutlineItem[] = toc.map(entry => {
    const target = entry.target ? anchors.get(entry.target) : undefined;
    const chapter = target ? byId.get(target.chapterId) : undefined;
    const destination =
      target && chapter && target.paraIndex < chapter.paragraphs.length
        ? target
        : {};
    return {
      id: crypto.randomUUID(),
      title: entry.title,
      depth: Math.min(entry.depth, 3),
      ...destination,
    };
  });
  return { chapters, outline };
}
