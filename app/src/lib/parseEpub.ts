import JSZip from 'jszip';
import { uid } from './db';
import { normalizeParagraph } from './reflow';
import type { Chapter } from '@/types';
import type { ParsedBook } from './parsePdf';

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

function resolvePath(base: string, href: string): string {
  // 去掉锚点与查询
  const clean = decodeURIComponent(href.split('#')[0]);
  const parts = (base + clean).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

async function zipText(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  return f ? f.async('text') : null;
}

/** 递归遍历正文 DOM，按阅读顺序收集块级元素 */
function collectBlocks(root: Element): { heading: number; text: string }[] {
  const out: { heading: number; text: string }[] = [];
  const BLOCK = new Set(['P', 'BLOCKQUOTE', 'LI', 'PRE', 'TD']);
  const HEAD = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const walk = (el: Element) => {
    for (const node of Array.from(el.children)) {
      const tag = node.tagName.toUpperCase();
      if (HEAD.has(tag)) {
        const text = (node.textContent ?? '').trim();
        if (text) out.push({ heading: Number(tag[1]), text });
      } else if (BLOCK.has(tag)) {
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) out.push({ heading: 0, text: normalizeParagraph(text) });
      } else if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'SVG') {
        walk(node);
      }
    }
  };
  walk(root);
  return out;
}

/** EPUB 封面图 → 缩小后的 dataURL */
async function coverDataUrl(zip: JSZip, path: string): Promise<string | undefined> {
  try {
    const f = zip.file(path);
    if (!f) return undefined;
    const blob = await f.async('blob');
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 420 / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(bmp.width * scale);
    canvas.height = Math.floor(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch {
    return undefined;
  }
}

export async function parseEpub(
  file: File,
  onProgress?: (stage: string, ratio: number) => void,
): Promise<ParsedBook> {
  onProgress?.('解压 EPUB', 0.05);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const containerXml = await zipText(zip, 'META-INF/container.xml');
  if (!containerXml) throw new Error('不是有效的 EPUB 文件');
  const container = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('找不到 EPUB 主文档');
  const opfDir = dirname(opfPath);

  onProgress?.('读取书目信息', 0.12);
  const opf = new DOMParser().parseFromString((await zipText(zip, opfPath)) ?? '', 'application/xml');
  const title =
    opf.getElementsByTagName('dc:title')[0]?.textContent?.trim() ||
    file.name.replace(/\.epub$/i, '');
  const author = opf.getElementsByTagName('dc:creator')[0]?.textContent?.trim() ?? '';

  const manifest = new Map<string, { href: string; props: string; type: string }>();
  for (const it of Array.from(opf.querySelectorAll('manifest > item'))) {
    const id = it.getAttribute('id');
    const href = it.getAttribute('href');
    if (id && href)
      manifest.set(id, {
        href: resolvePath(opfDir, href),
        props: it.getAttribute('properties') ?? '',
        type: it.getAttribute('media-type') ?? '',
      });
  }
  const spine: string[] = [];
  for (const ir of Array.from(opf.querySelectorAll('spine > itemref'))) {
    const idref = ir.getAttribute('idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (item && (item.type.includes('xhtml') || item.type.includes('html'))) spine.push(item.href);
  }

  // 封面
  let cover: string | undefined;
  for (const item of manifest.values()) {
    if (item.props.includes('cover-image')) {
      cover = await coverDataUrl(zip, item.href);
      break;
    }
  }
  if (!cover) {
    const metaCover = opf.querySelector('metadata > meta[name="cover"]')?.getAttribute('content');
    const item = metaCover ? manifest.get(metaCover) : undefined;
    if (item) cover = await coverDataUrl(zip, item.href);
  }

  // 目录（nav 或 ncx）：href → 标题
  const tocTitles = new Map<string, string>();
  const navItem = [...manifest.values()].find((i) => i.props.includes('nav'));
  if (navItem) {
    const navXml = await zipText(zip, navItem.href);
    if (navXml) {
      const nav = new DOMParser().parseFromString(navXml, 'application/xhtml+xml');
      for (const a of Array.from(nav.querySelectorAll('nav a'))) {
        const href = a.getAttribute('href');
        if (href) tocTitles.set(resolvePath(dirname(navItem.href), href), (a.textContent ?? '').trim());
      }
    }
  } else {
    const ncxItem = [...manifest.values()].find((i) => i.href.endsWith('.ncx'));
    if (ncxItem) {
      const ncxXml = await zipText(zip, ncxItem.href);
      if (ncxXml) {
        const ncx = new DOMParser().parseFromString(ncxXml, 'application/xml');
        for (const np of Array.from(ncx.querySelectorAll('navPoint'))) {
          const label = np.querySelector('navLabel text')?.textContent?.trim();
          const src = np.querySelector('content')?.getAttribute('src');
          if (label && src) tocTitles.set(resolvePath(dirname(ncxItem.href), src), label);
        }
      }
    }
  }

  onProgress?.('解析章节', 0.2);
  const chapters: Chapter[] = [];
  for (let i = 0; i < spine.length; i++) {
    if (i % 3 === 0) onProgress?.('解析章节', 0.2 + 0.75 * (i / Math.max(1, spine.length)));
    const html = await zipText(zip, spine[i]);
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
    const body = doc.querySelector('body');
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
        if (!started && (b.text === cur.title || cur.title === `第 ${chapters.length + 1} 节`)) {
          if (cur.title.startsWith('第 ') && cur.title.endsWith(' 节')) cur.title = b.text;
          started = true;
          continue;
        }
        if (cur.paragraphs.length > 0) {
          chapters.push(cur);
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
  }

  if (chapters.length === 0) throw new Error('未能从 EPUB 中识别出正文');
  return { title, author, cover, chapters };
}
