import JSZip from "jszip";
import { uid } from "./db";
import { normalizeParagraph } from "./reflow";
import type { BookContributorRole, Chapter } from "@/types";
import type { ParsedBook } from "./parseBook";
import { importedBookMetadata } from "./importMetadata";

const MIB = 1024 * 1024;

export const EPUB_LIMITS = {
  fileBytes: 128 * MIB,
  entries: 10_000,
  entryBytes: 64 * MIB,
  declaredTotalBytes: 256 * MIB,
  actualReadBytes: 128 * MIB,
  containerBytes: 256 * 1024,
  containerCharacters: 128_000,
  opfBytes: 4 * MIB,
  opfCharacters: 2_000_000,
  tocBytes: 4 * MIB,
  tocCharacters: 2_000_000,
  chapterBytes: 12 * MIB,
  chapterCharacters: 8_000_000,
  coverBytes: 12 * MIB,
  bookCharacters: 24_000_000,
  metadataCharacters: 500,
  spineItems: 4_000,
  outputChapters: 8_000,
  blocksPerChapter: 50_000,
} as const;

export interface EpubEntryInfo {
  name: string;
  directory?: boolean;
  uncompressedSize?: number;
}

interface SizedZipObject extends JSZip.JSZipObject {
  _data?: { uncompressedSize?: number };
  internalStream(type: "uint8array"): ZipByteStream;
}

interface ZipByteStream {
  on(event: "data", callback: (chunk: Uint8Array) => void): ZipByteStream;
  on(event: "end", callback: () => void): ZipByteStream;
  on(event: "error", callback: (error: Error) => void): ZipByteStream;
  pause(): ZipByteStream;
  resume(): ZipByteStream;
}

interface EpubReadBudget {
  actualBytes: number;
}

class EpubResourceLimitError extends Error {}

export function validateEpubFileSize(size: number): void {
  if (!Number.isFinite(size) || size < 0) {
    throw new Error("EPUB 文件大小无效");
  }
  if (size > EPUB_LIMITS.fileBytes) {
    throw new Error("EPUB 文件超过 128 MB，请压缩或拆分后再导入");
  }
}

/** Validate central-directory metadata before decompressing any ZIP member. */
export function validateEpubEntryLimits(entries: EpubEntryInfo[]): void {
  if (entries.length > EPUB_LIMITS.entries) {
    throw new Error(`EPUB 压缩包条目超过 ${EPUB_LIMITS.entries} 个`);
  }

  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.name.length > 2_048) {
      throw new Error("EPUB 压缩包包含过长的条目名");
    }
    if (entry.directory || entry.uncompressedSize === undefined) continue;
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0
    ) {
      throw new Error(`EPUB 条目大小无效：${entry.name}`);
    }
    if (entry.uncompressedSize > EPUB_LIMITS.entryBytes) {
      throw new Error(`EPUB 单个条目解压后过大：${entry.name}`);
    }
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > EPUB_LIMITS.declaredTotalBytes) {
      throw new Error("EPUB 声明的解压总量超过 256 MB");
    }
  }
}

function declaredSize(entry: JSZip.JSZipObject): number | undefined {
  const size = (entry as SizedZipObject)._data?.uncompressedSize;
  return typeof size === "number" ? size : undefined;
}

export function validateEpubArchive(zip: JSZip): void {
  validateEpubEntryLimits(
    Object.values(zip.files).map(entry => ({
      name: entry.name,
      directory: entry.dir,
      uncompressedSize: declaredSize(entry),
    }))
  );
}

function boundedMetadata(value: string, label: string): string {
  const text = value.trim();
  if (text.length > EPUB_LIMITS.metadataCharacters) {
    throw new EpubResourceLimitError(
      `${label}超过 ${EPUB_LIMITS.metadataCharacters} 个字符`
    );
  }
  return text;
}

function elementsByLocalName(
  root: Document | Element,
  localName: string
): Element[] {
  const elements = new Set<Element>();
  try {
    for (const element of Array.from(
      root.getElementsByTagNameNS("*", localName)
    )) {
      elements.add(element);
    }
  } catch {
    // Some older EPUB DOM implementations do not support wildcard namespaces.
  }
  for (const tagName of [`dc:${localName}`, localName]) {
    for (const element of Array.from(root.getElementsByTagName(tagName))) {
      elements.add(element);
    }
  }
  return [...elements];
}

function elementText(element: Element): string {
  return (element.textContent ?? "").replaceAll("\0", "").trim();
}

function namespacedAttribute(element: Element, name: string): string {
  return (
    element.getAttribute(`opf:${name}`) ??
    element.getAttribute(name) ??
    element.getAttributeNS("http://www.idpf.org/2007/opf", name) ??
    ""
  ).trim();
}

function refinedProperty(
  metas: Element[],
  targetId: string,
  property: string
): string {
  if (!targetId) return "";
  const refinement = metas.find(
    meta =>
      meta.getAttribute("refines") === `#${targetId}` &&
      meta.getAttribute("property")?.toLowerCase() === property
  );
  return refinement ? elementText(refinement) : "";
}

const EPUB_CONTRIBUTOR_ROLES: Record<string, BookContributorRole> = {
  aut: "author",
  author: "author",
  edt: "editor",
  editor: "editor",
  trl: "translator",
  translator: "translator",
  ill: "illustrator",
  illustrator: "illustrator",
};

function contributorRole(
  element: Element,
  metas: Element[],
  fallback: BookContributorRole
): BookContributorRole {
  const raw = (
    namespacedAttribute(element, "role") ||
    refinedProperty(metas, element.getAttribute("id") ?? "", "role")
  )
    .trim()
    .toLowerCase();
  return EPUB_CONTRIBUTOR_ROLES[raw] ?? fallback;
}

function identifierScheme(
  element: Element,
  metas: Element[]
): string | undefined {
  const direct = namespacedAttribute(element, "scheme");
  const refined = refinedProperty(
    metas,
    element.getAttribute("id") ?? "",
    "identifier-type"
  );
  const hint = direct || refined;
  // ONIX codelist 5 value 15 means ISBN-13.
  return hint === "15" ? "ISBN" : hint || undefined;
}

export interface EpubPackageFields {
  title: string;
  author: string;
  metadata?: ParsedBook["metadata"];
}

/** Extract bounded EPUB 2/3 Dublin Core metadata from the package document. */
export function extractEpubPackageFields(
  opf: Document,
  fallbackTitle: string
): EpubPackageFields {
  const metadataRoot = elementsByLocalName(opf, "metadata")[0];
  if (!metadataRoot) {
    return {
      title: boundedMetadata(fallbackTitle, "EPUB 书名").slice(0, 255),
      author: "",
    };
  }

  const metas = elementsByLocalName(metadataRoot, "meta");
  const titles = elementsByLocalName(metadataRoot, "title");
  const titleType = (element: Element) =>
    (
      namespacedAttribute(element, "type") ||
      refinedProperty(
        metas,
        element.getAttribute("id") ?? "",
        "title-type"
      )
    ).toLowerCase();
  const subtitleElement = titles.find(element =>
    titleType(element).split(/\s+/).includes("subtitle")
  );
  const mainTitleElement =
    titles.find(element =>
      titleType(element).split(/\s+/).includes("main")
    ) ?? titles.find(element => element !== subtitleElement);
  const selectedTitle = mainTitleElement ?? titles[0];
  const title = boundedMetadata(
    (selectedTitle ? elementText(selectedTitle) : "") || fallbackTitle,
    "EPUB 书名"
  ).slice(0, 255);

  const creators = elementsByLocalName(metadataRoot, "creator")
    .map(element => ({
      name: elementText(element),
      role: contributorRole(element, metas, "author"),
    }))
    .filter(contributor => Boolean(contributor.name));
  const contributors = elementsByLocalName(metadataRoot, "contributor")
    .map(element => ({
      name: elementText(element),
      role: contributorRole(element, metas, "other"),
    }))
    .filter(contributor => Boolean(contributor.name));
  const metadata = importedBookMetadata({
    subtitle: subtitleElement ? elementText(subtitleElement) : undefined,
    contributors: [...creators, ...contributors],
    publishers: elementsByLocalName(metadataRoot, "publisher").map(elementText),
    publishedDates: elementsByLocalName(metadataRoot, "date")
      .sort((left, right) => {
        const publication = (element: Element) =>
          namespacedAttribute(element, "event").toLowerCase() ===
          "publication"
            ? 0
            : 1;
        return publication(left) - publication(right);
      })
      .map(elementText),
    languages: elementsByLocalName(metadataRoot, "language").map(elementText),
    identifiers: elementsByLocalName(metadataRoot, "identifier").map(
      element => ({
        value: elementText(element),
        scheme: identifierScheme(element, metas),
      })
    ),
    subjects: elementsByLocalName(metadataRoot, "subject").map(elementText),
    descriptions: elementsByLocalName(metadataRoot, "description").map(
      elementText
    ),
    rights: elementsByLocalName(metadataRoot, "rights").map(elementText),
  });
  const author =
    metadata?.contributors
      ?.filter(contributor => contributor.role === "author")
      .map(contributor => contributor.name)
      .join("、")
      .slice(0, 255) ?? "";
  return { title, author, metadata };
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

function resolvePath(base: string, href: string): string {
  // 去掉锚点与查询
  const clean = decodeURIComponent(href.split("#")[0]);
  const parts = (base + clean).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

async function zipBytes(
  zip: JSZip,
  path: string,
  budget: EpubReadBudget,
  entryLimit: number,
  label: string
): Promise<Uint8Array | null> {
  const file = zip.file(path);
  if (!file) return null;
  const declared = declaredSize(file);
  if (declared !== undefined && declared > entryLimit) {
    throw new EpubResourceLimitError(`${label}解压后内容过大`);
  }

  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    let settled = false;
    const stream = (file as SizedZipObject).internalStream("uint8array");

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      stream.pause();
      reject(error);
    };

    stream
      .on("data", chunk => {
        if (settled) return;
        entryBytes += chunk.byteLength;
        budget.actualBytes += chunk.byteLength;
        if (entryBytes > entryLimit) {
          fail(new EpubResourceLimitError(`${label}解压后内容过大`));
          return;
        }
        if (budget.actualBytes > EPUB_LIMITS.actualReadBytes) {
          fail(new EpubResourceLimitError("EPUB 实际解压读取量超过 128 MB"));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", error => fail(error))
      .on("end", () => {
        if (settled) return;
        settled = true;
        const bytes = new Uint8Array(entryBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(bytes);
      })
      .resume();
  });
}

async function zipText(
  zip: JSZip,
  path: string,
  budget: EpubReadBudget,
  byteLimit: number,
  characterLimit: number,
  label: string
): Promise<string | null> {
  const bytes = await zipBytes(zip, path, budget, byteLimit, label);
  if (!bytes) return null;
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.length > characterLimit) {
    throw new EpubResourceLimitError(`${label}文本过长`);
  }
  return text;
}

/** 递归遍历正文 DOM，按阅读顺序收集块级元素 */
function collectBlocks(root: Element): { heading: number; text: string }[] {
  const out: { heading: number; text: string }[] = [];
  const BLOCK = new Set(["P", "BLOCKQUOTE", "LI", "PRE", "TD"]);
  const HEAD = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
  const walk = (el: Element) => {
    for (const node of Array.from(el.children)) {
      const tag = node.tagName.toUpperCase();
      if (HEAD.has(tag)) {
        const text = (node.textContent ?? "").trim();
        if (text)
          out.push({
            heading: Number(tag[1]),
            text: text.slice(0, EPUB_LIMITS.metadataCharacters),
          });
      } else if (BLOCK.has(tag)) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) out.push({ heading: 0, text: normalizeParagraph(text) });
      } else if (tag !== "SCRIPT" && tag !== "STYLE" && tag !== "SVG") {
        walk(node);
      }
      if (out.length > EPUB_LIMITS.blocksPerChapter) {
        throw new EpubResourceLimitError("单个 EPUB 章节的段落数过多");
      }
    }
  };
  walk(root);
  return out;
}

/** EPUB 封面图 → 缩小后的 dataURL */
async function coverDataUrl(
  zip: JSZip,
  path: string,
  budget: EpubReadBudget
): Promise<string | undefined> {
  const entry = zip.file(path);
  if (!entry) return undefined;
  const declared = declaredSize(entry);
  if (declared !== undefined && declared > EPUB_LIMITS.coverBytes) {
    return undefined;
  }

  const bytes = await zipBytes(
    zip,
    path,
    budget,
    EPUB_LIMITS.coverBytes,
    "EPUB 封面"
  );
  if (!bytes) return undefined;

  try {
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([data]);
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 420 / bmp.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(bmp.width * scale);
    canvas.height = Math.floor(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    return undefined;
  }
}

export async function parseEpub(
  file: File,
  onProgress?: (stage: string, ratio: number) => void
): Promise<ParsedBook> {
  validateEpubFileSize(file.size);
  onProgress?.("解压 EPUB", 0.05);
  const source = await file.arrayBuffer();
  validateEpubFileSize(source.byteLength);
  const zip = await JSZip.loadAsync(source);
  validateEpubArchive(zip);
  const budget: EpubReadBudget = { actualBytes: 0 };

  const containerXml = await zipText(
    zip,
    "META-INF/container.xml",
    budget,
    EPUB_LIMITS.containerBytes,
    EPUB_LIMITS.containerCharacters,
    "EPUB container.xml"
  );
  if (!containerXml) throw new Error("不是有效的 EPUB 文件");
  const container = new DOMParser().parseFromString(
    containerXml,
    "application/xml"
  );
  const opfPath = container
    .querySelector("rootfile")
    ?.getAttribute("full-path");
  if (!opfPath) throw new Error("找不到 EPUB 主文档");
  if (opfPath.length > 2_048) throw new Error("EPUB 主文档路径过长");
  const opfDir = dirname(opfPath);

  onProgress?.("读取书目信息", 0.12);
  const opf = new DOMParser().parseFromString(
    (await zipText(
      zip,
      opfPath,
      budget,
      EPUB_LIMITS.opfBytes,
      EPUB_LIMITS.opfCharacters,
      "EPUB OPF"
    )) ?? "",
    "application/xml"
  );
  const packageFields = extractEpubPackageFields(
    opf,
    file.name.replace(/\.epub$/i, "")
  );
  const { title, author, metadata } = packageFields;

  const manifest = new Map<
    string,
    { href: string; props: string; type: string }
  >();
  for (const it of Array.from(opf.querySelectorAll("manifest > item"))) {
    const id = it.getAttribute("id");
    const href = it.getAttribute("href");
    if (id && href)
      manifest.set(id, {
        href: resolvePath(opfDir, href),
        props: it.getAttribute("properties") ?? "",
        type: it.getAttribute("media-type") ?? "",
      });
  }
  const spine: string[] = [];
  for (const ir of Array.from(opf.querySelectorAll("spine > itemref"))) {
    const idref = ir.getAttribute("idref");
    const item = idref ? manifest.get(idref) : undefined;
    if (item && (item.type.includes("xhtml") || item.type.includes("html")))
      spine.push(item.href);
  }
  if (spine.length > EPUB_LIMITS.spineItems) {
    throw new Error(`EPUB 书脊条目超过 ${EPUB_LIMITS.spineItems} 个`);
  }

  // 封面
  let cover: string | undefined;
  for (const item of manifest.values()) {
    if (item.props.includes("cover-image")) {
      cover = await coverDataUrl(zip, item.href, budget);
      break;
    }
  }
  if (!cover) {
    const metaCover = opf
      .querySelector('metadata > meta[name="cover"]')
      ?.getAttribute("content");
    const item = metaCover ? manifest.get(metaCover) : undefined;
    if (item) cover = await coverDataUrl(zip, item.href, budget);
  }

  // 目录（nav 或 ncx）：href → 标题
  const tocTitles = new Map<string, string>();
  const navItem = [...manifest.values()].find(i => i.props.includes("nav"));
  if (navItem) {
    const navXml = await zipText(
      zip,
      navItem.href,
      budget,
      EPUB_LIMITS.tocBytes,
      EPUB_LIMITS.tocCharacters,
      "EPUB 目录"
    );
    if (navXml) {
      const nav = new DOMParser().parseFromString(
        navXml,
        "application/xhtml+xml"
      );
      for (const a of Array.from(nav.querySelectorAll("nav a"))) {
        const href = a.getAttribute("href");
        if (href)
          tocTitles.set(
            resolvePath(dirname(navItem.href), href),
            (a.textContent ?? "")
              .trim()
              .slice(0, EPUB_LIMITS.metadataCharacters)
          );
      }
    }
  } else {
    const ncxItem = [...manifest.values()].find(i => i.href.endsWith(".ncx"));
    if (ncxItem) {
      const ncxXml = await zipText(
        zip,
        ncxItem.href,
        budget,
        EPUB_LIMITS.tocBytes,
        EPUB_LIMITS.tocCharacters,
        "EPUB NCX 目录"
      );
      if (ncxXml) {
        const ncx = new DOMParser().parseFromString(ncxXml, "application/xml");
        for (const np of Array.from(ncx.querySelectorAll("navPoint"))) {
          const label = np.querySelector("navLabel text")?.textContent?.trim();
          const src = np.querySelector("content")?.getAttribute("src");
          if (label && src)
            tocTitles.set(
              resolvePath(dirname(ncxItem.href), src),
              label.slice(0, EPUB_LIMITS.metadataCharacters)
            );
        }
      }
    }
  }

  onProgress?.("解析章节", 0.2);
  const chapters: Chapter[] = [];
  let bookCharacters = title.length + author.length;
  for (let i = 0; i < spine.length; i++) {
    const chaptersBefore = chapters.length;
    if (i % 3 === 0)
      onProgress?.("解析章节", 0.2 + 0.75 * (i / Math.max(1, spine.length)));
    const html = await zipText(
      zip,
      spine[i],
      budget,
      EPUB_LIMITS.chapterBytes,
      EPUB_LIMITS.chapterCharacters,
      `EPUB 章节 ${i + 1}`
    );
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, "application/xhtml+xml");
    const body = doc.querySelector("body");
    if (!body) continue;
    const blocks = collectBlocks(body);
    if (blocks.length === 0) continue;

    let cur: Chapter = {
      id: uid(),
      title: tocTitles.get(spine[i]) || `第 ${chapters.length + 1} 节`,
      paragraphs: [],
    };
    let started = false;
    for (const b of blocks) {
      if (b.heading > 0 && b.heading <= 2) {
        // 跳过与目录标题重复的首个标题
        if (
          !started &&
          (b.text === cur.title || cur.title === `第 ${chapters.length + 1} 节`)
        ) {
          if (cur.title.startsWith("第 ") && cur.title.endsWith(" 节"))
            cur.title = b.text;
          started = true;
          continue;
        }
        if (cur.paragraphs.length > 0) {
          chapters.push(cur);
          if (chapters.length > EPUB_LIMITS.outputChapters) {
            throw new Error(
              `EPUB 识别出的章节超过 ${EPUB_LIMITS.outputChapters} 个`
            );
          }
          cur = { id: uid(), title: b.text, paragraphs: [] };
        } else {
          cur.title = b.text;
        }
        started = true;
      } else {
        cur.paragraphs.push(b.text);
        started = true;
      }
    }
    if (cur.paragraphs.length > 0) chapters.push(cur);
    for (const chapter of chapters.slice(chaptersBefore)) {
      bookCharacters += chapter.title.length;
      for (const paragraph of chapter.paragraphs)
        bookCharacters += paragraph.length;
    }
    if (bookCharacters > EPUB_LIMITS.bookCharacters) {
      throw new Error("EPUB 正文超过 2400 万字符");
    }
    if (chapters.length > EPUB_LIMITS.outputChapters) {
      throw new Error(`EPUB 识别出的章节超过 ${EPUB_LIMITS.outputChapters} 个`);
    }
  }

  if (chapters.length === 0) throw new Error("未能从 EPUB 中识别出正文");
  return { title, author, cover, chapters, metadata };
}
