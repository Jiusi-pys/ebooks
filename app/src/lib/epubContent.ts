import type { Chapter, EpubFootnote, OutlineItem } from "@/types";
import { normalizeParagraph } from "./reflow";
import type {
  EpubChapterLayout,
  EpubFigureChild,
  EpubImageItem,
  EpubInlineImage,
  EpubLayout,
  EpubLayoutItem,
  EpubLayoutNote,
  EpubParagraphRole,
  EpubTextItem,
} from "./epubLayout";

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
  role?: EpubParagraphRole;
  images: EpubInlineImage[];
}

/** Resolve local raster resources only; never turn an encoded URL into a fetch. */
export function epubResourcePath(base: string, src: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    throw new Error("EPUB 图片路径编码无效");
  }
  if (
    !decoded ||
    decoded.length > 2048 ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded) ||
    decoded.startsWith("/") ||
    /[\\?#]/.test(decoded) ||
    Array.from(decoded).some(
      c => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127
    )
  )
    throw new Error("EPUB 图片资源必须位于压缩包内");
  const path = epubTarget(base, src);
  if (!path) throw new Error("EPUB 图片路径超出压缩包");
  return path;
}

export interface EpubContentOptions {
  coverPaths?: Set<string>;
  coverNodes?: Set<Element>;
  coverImages?: Set<string>;
}

type DraftChild =
  { kind: "block"; block: Block } | EpubImageItem | EpubTextItem;
type Draft = DraftChild | { kind: "figure"; items: DraftChild[] };

export function parseEpubContent(
  docs: Map<string, Document>,
  spine: string[],
  toc: EpubTocEntry[],
  options: EpubContentOptions = {}
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
      notes.set(key, normalize(clone.textContent ?? ""));
    }
  }
  const chapters: Chapter[] = [];
  const anchors = new Map<string, { chapterId: string; paraIndex?: number }>();
  const layout: EpubLayout = { version: 1, assets: {}, chapters: {} };
  const imagePaths = new Set<string>();
  let characterCount = 0;
  const countText = (text: string, refs: EpubLayoutNote[]) => {
    characterCount +=
      text.length + refs.reduce((n, ref) => n + ref.content.length, 0);
    if (characterCount > 24000000)
      throw new Error("EPUB 正文及注释超过 2400 万字符");
  };
  for (const path of spine) {
    if (options.coverPaths?.has(path)) continue;
    const doc = docs.get(path);
    const body = doc?.querySelector("body");
    if (!body) continue;
    if (semantics(body).includes("cover") || options.coverNodes?.has(body))
      continue;
    const flow: Draft[] = [];
    let blockCount = 0;
    let layoutCount = 0;
    const seenAnchors = new Set<string>();
    const pendingAnchors: string[] = [];
    const visualAnchors = new WeakMap<object, string[]>();
    const imageElements = new WeakMap<EpubInlineImage, Element>();
    const collectAnchors = (el: Element) => {
      const anchorIds = [
        ...pendingAnchors.splice(0),
        ...Array.from(el.querySelectorAll("[id]")).map(n => n.id),
      ];
      for (let p: Element | null = el; p; p = p.parentElement)
        if (p.id) anchorIds.push(p.id);
      const unique = anchorIds.filter(id => !seenAnchors.has(id));
      unique.forEach(id => seenAnchors.add(id));
      return unique;
    };
    const image = (el: Element): EpubImageItem | undefined => {
      const assetId = epubResourcePath(path, el.getAttribute("src") ?? "");
      if (options.coverImages?.has(assetId)) return;
      imagePaths.add(assetId);
      return { kind: "image", assetId, alt: el.getAttribute("alt") ?? "" };
    };
    const excluded = (el: Element) =>
      ["script", "style", "nav"].includes(tag(el)) ||
      isNote(el) ||
      semantics(el).includes("cover") ||
      options.coverNodes?.has(el);
    const inline = (nodes: Node[], root?: Element) => {
      let raw = "";
      const refs: EpubLayoutNote[] = [];
      const images: EpubInlineImage[] = [];
      const visit = (node: Node) => {
        if (node.nodeType === 3) {
          raw += node.textContent;
          return;
        }
        if (node.nodeType !== 1) return;
        const child = node as Element;
        if (child !== root && excluded(child)) return;
        if (tag(child) === "svg")
          throw new Error(
            "EPUB 正文 SVG 图片暂不支持，请转换为 PNG/JPEG/GIF/WebP"
          );
        if (tag(child) === "img") {
          const found = image(child);
          if (found) {
            const item: EpubInlineImage = {
              offset: raw.length,
              order: images.length,
              assetId: found.assetId,
              alt: found.alt,
            };
            imageElements.set(item, child);
            images.push(item);
          }
          return;
        }
        if (tag(child) === "br") {
          raw += " ";
          return;
        }
        const start = raw.length;
        for (const n of Array.from(child.childNodes)) visit(n);
        const key =
          tag(child) === "a"
            ? epubTarget(path, child.getAttribute("href") ?? "")
            : undefined;
        if (key && notes.has(key))
          refs.push({ start, end: raw.length, content: notes.get(key)! });
      };
      nodes.forEach(visit);
      return {
        text: normalize(raw),
        notes: refs
          .map(r => ({
            ...r,
            start: normalize(raw.slice(0, r.start)).length,
            end: normalize(raw.slice(0, r.end)).length,
          }))
          .filter(r => r.end > r.start),
        images: images.map(i => {
          const normalized = {
            ...i,
            offset: normalize(raw.slice(0, i.offset)).length,
          };
          imageElements.set(normalized, imageElements.get(i)!);
          return normalized;
        }),
      };
    };
    const credit = (el: Element) =>
      semantics(el).includes("credit") ||
      /(?:^|\s)(?:credit|source|attribution)(?:\s|$)/i.test(
        el.getAttribute("class") ?? ""
      );
    const noteOnly = (text: string, refs: EpubLayoutNote[]) => {
      let remaining = text;
      for (const ref of [...refs].sort((a, b) => b.start - a.start))
        remaining = remaining.slice(0, ref.start) + remaining.slice(ref.end);
      return !!refs.length && !remaining.trim();
    };
    const walk = (
      parent: Element,
      sink: Draft[],
      inFigure = false,
      inheritedRole?: EpubParagraphRole
    ) => {
      let pending: Node[] = [];
      const flush = () => {
        if (!pending.length) return;
        const read = inline(pending);
        pending = [];
        // These strings never enter the synchronized paragraph array.
        const text = (start: number, end: number) => {
          const raw = read.text.slice(start, end);
          const value = normalize(raw);
          if (!value) return;
          const refs = read.notes
            .filter(ref => ref.start < end && ref.end > start)
            .map(ref => ({
              content: ref.content,
              start: normalize(raw.slice(0, Math.max(0, ref.start - start)))
                .length,
              end: normalize(
                raw.slice(0, Math.min(raw.length, ref.end - start))
              ).length,
            }))
            .filter(ref => ref.end > ref.start);
          const role =
            inheritedRole ?? (noteOnly(value, refs) ? "image-note" : undefined);
          sink.push({
            kind: "text",
            text: value,
            notes: refs,
            ...(role ? { role } : {}),
          });
        };
        let cursor = 0;
        for (const image of read.images) {
          text(cursor, image.offset);
          const draft: EpubImageItem = {
            kind: "image",
            assetId: image.assetId,
            alt: image.alt,
          };
          const element = imageElements.get(image);
          if (element) visualAnchors.set(draft, collectAnchors(element));
          sink.push(draft);
          cursor = image.offset;
        }
        text(cursor, read.text.length);
      };
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === 3) {
          if (inFigure || inheritedRole) pending.push(node);
          continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (excluded(el)) continue;
        if (tag(el) === "svg")
          throw new Error(
            "EPUB 正文 SVG 图片暂不支持，请转换为 PNG/JPEG/GIF/WebP"
          );
        if (tag(el) === "img") {
          flush();
          const found = image(el);
          if (found) {
            visualAnchors.set(found, collectAnchors(el));
            sink.push(found);
          }
          continue;
        }
        if (tag(el) === "figure") {
          flush();
          if (inFigure) {
            walk(el, sink, true, inheritedRole);
            continue;
          }
          const grouped: DraftChild[] = [];
          walk(el, grouped, true);
          if (grouped.length)
            sink.push({ kind: "figure", items: grouped } as Draft);
          continue;
        }
        const ownRole = credit(el)
          ? "credit"
          : /(?:^|\s)(?:caption|figcaption)(?:\s|$)/i.test(
                el.getAttribute("class") ?? ""
              )
            ? "caption"
            : inheritedRole;
        if (tag(el) === "figcaption") {
          flush();
          walk(el, sink, inFigure, "caption");
          continue;
        }
        if (
          (inFigure ||
            inheritedRole ||
            isRef(el) ||
            Array.from(el.querySelectorAll("a")).some(isRef)) &&
          !/^h[1-6]$/.test(tag(el)) &&
          ![
            "p",
            "blockquote",
            "li",
            "pre",
            "td",
            "section",
            "div",
            "ol",
            "ul",
            "table",
            "tbody",
            "tr",
            "dl",
            "dd",
            "dt",
            "address",
          ].includes(tag(el))
        ) {
          if (ownRole === "credit") {
            flush();
            walk(el, sink, inFigure, "credit");
          } else pending.push(el);
          continue;
        }
        flush();
        if (el.id && !normalize(el.textContent ?? ""))
          pendingAnchors.push(el.id);
        if (
          /^h[1-6]$/.test(tag(el)) ||
          ["p", "blockquote", "li", "pre", "td"].includes(tag(el))
        ) {
          const read = inline([el], el);
          const value = read.text;
          if (!value) {
            const images = read.images.map(i => ({
              kind: "image" as const,
              assetId: i.assetId,
              alt: i.alt,
            }));
            if (images.length) visualAnchors.set(images[0], collectAnchors(el));
            sink.push(...images);
            continue;
          }
          const unique = collectAnchors(el);
          const creditOnly = Array.from(
            el.querySelectorAll("[epub\\:type], [class]")
          ).some(
            child =>
              credit(child) && normalize(child.textContent ?? "") === value
          );
          const blockRole = creditOnly
            ? "credit"
            : (ownRole ??
              (inFigure && noteOnly(value, read.notes)
                ? "image-note"
                : undefined));
          sink.push({
            kind: "block",
            block: {
              heading: /^h[1-6]$/.test(tag(el)) ? Number(tag(el)[1]) : 0,
              text: value,
              anchors: unique,
              notes: read.notes,
              images: read.images,
              ...(blockRole ? { role: blockRole } : {}),
            },
          });
          if (++blockCount > 50000)
            throw new Error("单个 EPUB 章节的段落数过多");
        } else walk(el, sink, inFigure, ownRole);
      }
      flush();
    };
    walk(body, flow);
    if (!flow.length) continue;
    let current: Chapter = {
      id: crypto.randomUUID(),
      title:
        toc.find(t => t.target === path)?.title ||
        `第 ${chapters.length + 1} 节`,
      paragraphs: [],
    };
    const firstChapter = current.id;
    let currentLayout: EpubChapterLayout = { items: [] };
    const publish = () => {
      if (current.paragraphs.length || currentLayout.items.length) {
        chapters.push(current);
        layout.chapters[current.id] = currentLayout;
      }
      if (chapters.length > 8000) throw new Error("EPUB 识别出的章节过多");
    };
    const append = (
      draft: DraftChild,
      sink: () => EpubFigureChild[] | EpubLayoutItem[]
    ) => {
      if (++layoutCount > 50000)
        throw new Error("单个 EPUB 章节的布局条目过多");
      if (draft.kind !== "block") {
        for (const id of visualAnchors.get(draft) ?? [])
          if (ids.get(`${path}#${id}`))
            anchors.set(`${path}#${id}`, { chapterId: current.id });
        sink().push(draft);
        if (draft.kind === "text") countText(draft.text, draft.notes);
        return;
      }
      const block = draft.block;
      if (block.heading > 0 && block.heading <= 2) {
        if (current.paragraphs.length || currentLayout.items.length) {
          publish();
          current = {
            id: crypto.randomUUID(),
            title: block.text.slice(0, 500),
            paragraphs: [],
          };
          currentLayout = { items: [] };
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
        sink().push({
          kind: "paragraph",
          paraIndex,
          ...(block.role ? { role: block.role } : {}),
          ...(block.images.length ? { inlineImages: block.images } : {}),
        });
      } else if (block.images.length) {
        sink().push(
          ...block.images.map(i => ({
            kind: "image" as const,
            assetId: i.assetId,
            alt: i.alt,
          }))
        );
      }
      countText(block.text, block.notes);
    };
    for (const draft of flow) {
      if (draft.kind === "figure") {
        let chapterId = "";
        let children: EpubFigureChild[] = [];
        const sink = () => {
          if (chapterId !== current.id) {
            chapterId = current.id;
            children = [];
            currentLayout.items.push({ kind: "figure", items: children });
          }
          return children;
        };
        draft.items.forEach(child => append(child, sink));
      } else append(draft, () => currentLayout.items);
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
      target && chapter
        ? target.paraIndex !== undefined &&
          target.paraIndex < chapter.paragraphs.length
          ? target
          : { chapterId: target.chapterId }
        : {};
    return {
      id: crypto.randomUUID(),
      title: entry.title,
      depth: Math.min(entry.depth, 3),
      ...destination,
    };
  });
  return { chapters, outline, layout, imagePaths };
}
