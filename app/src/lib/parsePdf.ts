import { openPdfDocument, pdfjs } from "./pdfjs";
import { looksLikeHeading, reflowLines, type RawLine } from "./reflow";
import { uid } from "./db";
import type { Chapter } from "@/types";
import type { ParsedBook } from "./parseBook";
import {
  assertPdfFileSize,
  consumePdfTextBudget,
  supportsCompletePdfReflow,
  type PdfTextBudget,
} from "./pdfLimits";

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineItem[];
}

/** 提取一页的文本行（带几何信息，按阅读顺序排列） */
async function extractPageLines(
  page: pdfjs.PDFPageProxy,
  budget: PdfTextBudget
): Promise<RawLine[]> {
  const raw: { str: string; x: number; y: number; h: number }[] = [];
  const reader = page.streamTextContent().getReader();
  let pageItems = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const items = chunk.value.items as {
        str?: string;
        transform?: number[];
      }[];
      pageItems = consumePdfTextBudget(budget, items, pageItems);
      for (const it of items) {
        if (!it.str || !it.transform) continue;
        const t = it.transform;
        const h = Math.abs(t[3]) || Math.abs(t[0]) || 12;
        raw.push({ str: it.str, x: t[4], y: t[5], h });
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (raw.length === 0) return [];
  // 按 y 聚合成行（PDF y 轴向上，先按 y 降序 = 从上到下）
  raw.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { text: string; x: number; y: number; h: number }[] = [];
  for (const it of raw) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) < Math.max(2, last.h * 0.4)) {
      last.text += it.str;
      last.h = Math.max(last.h, it.h);
      last.x = Math.min(last.x, it.x);
    } else {
      lines.push({ text: it.str, x: it.x, y: it.y, h: it.h });
    }
  }
  const hs = lines.map(l => l.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)] || 12;
  const out: RawLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prev = lines[i - 1];
    out.push({
      text: lines[i].text,
      height: lines[i].h,
      x: lines[i].x,
      gapAbove: prev ? prev.y - lines[i].y : medH * 3,
    });
  }
  return out;
}

/** 渲染首页为封面缩略图 dataURL */
async function renderCover(
  page: pdfjs.PDFPageProxy
): Promise<string | undefined> {
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1.2, 420 / base.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return undefined;
  }
}

async function flattenOutline(
  doc: pdfjs.PDFDocumentProxy,
  items: OutlineItem[],
  depth: number,
  out: { title: string; pageIndex: number }[]
) {
  for (const it of items) {
    try {
      if (it.dest) {
        const dest =
          typeof it.dest === "string"
            ? await doc.getDestination(it.dest)
            : it.dest;
        if (Array.isArray(dest) && dest[0]) {
          const idx = await doc.getPageIndex(dest[0] as never);
          out.push({ title: it.title.trim(), pageIndex: idx });
        }
      }
    } catch {
      /* 忽略无法解析的书签 */
    }
    if (depth < 1 && it.items?.length)
      await flattenOutline(doc, it.items, depth + 1, out);
  }
}

export async function parsePdf(
  file: File,
  onProgress?: (stage: string, ratio: number) => void
): Promise<ParsedBook> {
  assertPdfFileSize(file.size);
  const data = await file.arrayBuffer();
  const loadingTask = openPdfDocument(data);
  try {
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;

    onProgress?.("读取元信息", 0.02);
    let title = file.name.replace(/\.pdf$/i, "");
    let author = "";
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, string>;
      if (info.Title?.trim()) title = info.Title.trim();
      if (info.Author?.trim()) author = info.Author.trim();
    } catch {
      /* 无元数据 */
    }

    const cover = await renderCover(await doc.getPage(1));

    // A partial text copy is worse than an explicit original-only import:
    // navigation/search must never claim success while omitting later pages.
    if (!supportsCompletePdfReflow(pageCount)) {
      onProgress?.("PDF 超过 600 页，仅保留原版版面", 0.95);
      return { title, author, cover, pageCount, chapters: [] };
    }

    // 目录书签 → 页码边界
    let outline: { title: string; pageIndex: number }[] = [];
    try {
      const top = (await doc.getOutline()) as OutlineItem[] | null;
      if (top?.length) {
        const flat: { title: string; pageIndex: number }[] = [];
        await flattenOutline(doc, top, 0, flat);
        outline = flat
          .filter(o => o.title)
          .sort((a, b) => a.pageIndex - b.pageIndex)
          .filter(o => o.pageIndex < pageCount);
      }
    } catch {
      /* 无目录 */
    }

    // 逐页提取并按章节边界切分
    const chapters: Chapter[] = [];
    let curTitle = outline.length ? "" : "正文";
    let curLines: RawLine[] = [];
    let nextBoundary = 0;
    /** 开新章后，跳过正文里与章标题重复的首行 */
    let pendingTitleSkip = "";
    const textBudget: PdfTextBudget = { characters: 0, items: 0 };

    const flush = () => {
      if (curLines.length === 0) return;
      chapters.push({
        id: uid(),
        title: curTitle || `第 ${chapters.length + 1} 节`,
        paragraphs: reflowLines(curLines),
      });
      curLines = [];
    };

    /** 入队一行；若正在等待跳过章标题行，则先过滤 */
    const pushLine = (ln: RawLine) => {
      if (pendingTitleSkip) {
        const norm = (s: string) => s.replace(/\s+/g, "");
        if (norm(ln.text) === norm(pendingTitleSkip)) {
          pendingTitleSkip = "";
          return;
        }
        if (ln.text.trim()) pendingTitleSkip = "";
      }
      curLines.push(ln);
    };

    for (let p = 1; p <= pageCount; p++) {
      if (p % 5 === 0 || p === pageCount)
        onProgress?.("解析文字", 0.05 + 0.9 * (p / pageCount));
      // 命中目录边界 → 开新章
      if (
        nextBoundary < outline.length &&
        p - 1 === outline[nextBoundary].pageIndex
      ) {
        flush();
        curTitle = outline[nextBoundary].title;
        pendingTitleSkip = curTitle;
        nextBoundary++;
        while (
          nextBoundary < outline.length &&
          outline[nextBoundary].pageIndex === p - 1
        )
          nextBoundary++;
      }
      const page = await doc.getPage(p);
      const lines = await extractPageLines(page, textBudget);
      if (!outline.length) {
        // 无目录：按版式启发式识别章节标题
        for (const ln of lines) {
          if (ln.height > 0 && looksLikeHeading(ln.text)) {
            flush();
            curTitle = ln.text.trim();
          } else {
            curLines.push(ln);
          }
        }
      } else {
        for (const ln of lines) pushLine(ln);
      }
    }
    flush();

    const nonEmpty = chapters.filter(c => c.paragraphs.length > 0);
    return {
      title,
      author,
      cover,
      pageCount: doc.numPages,
      chapters: nonEmpty.length ? nonEmpty : chapters,
    };
  } finally {
    await loadingTask.destroy();
  }
}
