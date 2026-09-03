import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ListTree,
  Loader2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { pdfjs } from '@/lib/pdfjs';
import { getFile } from '@/lib/db';
import 'pdfjs-dist/web/pdf_viewer.css';

type PdfDoc = pdfjs.PDFDocumentProxy;

interface TocEntry {
  title: string;
  page: number;
  depth: number;
}

export interface PdfSelectInfo {
  text: string;
  page: number;
  /** 视口坐标（用于 fixed 定位弹层） */
  x: number;
  y: number;
}

/**
 * 原版 PDF 阅读器：逐页 canvas 渲染 + 透明文本层（可划选）。
 * 进度以页码为单位，通过 onProgress 回报。
 */
export function PdfCanvasViewer({
  bookId,
  initialPage,
  onProgress,
  onSelectText,
  anchorText,
  onAnchorConsumed,
}: {
  bookId: string;
  initialPage: number;
  onProgress: (page: number, pageCount: number) => void;
  onSelectText: (info: PdfSelectInfo) => void;
  /** 设置后跳转至包含该文字的页（用于「回到原文」） */
  anchorText?: string | null;
  onAnchorConsumed?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderSeq = useRef(0);

  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(Math.max(1, initialPage));
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [pageInput, setPageInput] = useState('');

  /* ---------- 加载文档 ---------- */
  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    (async () => {
      const f = await getFile(bookId);
      if (!f) {
        setError('未找到原始 PDF 文件（可能是旧版本导入的书籍）。');
        return;
      }
      try {
        // 复制一份，避免 pdfjs 对 buffer 的转移影响 IndexedDB 中的数据
        const data = f.data.slice(0);
        loaded = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;
        setDoc(loaded);
        setPageCount(loaded.numPages);
        setPage((p) => Math.min(Math.max(1, p), loaded!.numPages));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'PDF 加载失败');
      }
    })();
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [bookId]);

  /* ---------- 大纲 ---------- */
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const out: TocEntry[] = [];
    const walk = async (items: Awaited<ReturnType<PdfDoc['getOutline']>>, depth: number) => {
      for (const it of items ?? []) {
        let pageNum = 0;
        try {
          if (it.dest) {
            const dest =
              typeof it.dest === 'string' ? await doc.getDestination(it.dest) : (it.dest as unknown[]);
            if (Array.isArray(dest) && dest[0]) {
              pageNum = (await doc.getPageIndex(dest[0] as Parameters<PdfDoc['getPageIndex']>[0])) + 1;
            }
          }
        } catch {
          /* 忽略无法解析的目录项 */
        }
        if (it.title) out.push({ title: it.title, page: pageNum, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    };
    (async () => {
      try {
        const outline = await doc.getOutline();
        out.length = 0;
        await walk(outline, 0);
        if (!cancelled) setToc([...out]);
      } catch {
        /* 无大纲 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  /* ---------- 容器宽度 → 适配缩放 ---------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setFitScale((w - 48) / 800); // 基准页宽 800pt，留 24px 边距
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- 渲染当前页 ---------- */
  useEffect(() => {
    if (!doc) return;
    const seq = ++renderSeq.current;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    setRendering(true);
    (async () => {
      try {
        const pg = await doc.getPage(page);
        if (seq !== renderSeq.current) return;
        const base = pg.getViewport({ scale: 1 });
        const el = containerRef.current;
        const fit = el && el.clientWidth > 0 ? (el.clientWidth - 48) / base.width : fitScale;
        if (Math.abs(fit - fitScale) > 0.01) setFitScale(fit);
        const scale = fit * zoom;
        const dpr = window.devicePixelRatio || 1;
        const viewport = pg.getViewport({ scale: scale * dpr });

        const canvas = canvasRef.current;
        const textDiv = textLayerRef.current;
        if (!canvas || !textDiv) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        renderTask = pg.render({ canvas, canvasContext: ctx, viewport });
        await renderTask.promise;
        if (seq !== renderSeq.current) return;

        // 文本层（用于划选）
        textDiv.innerHTML = '';
        textDiv.style.width = `${Math.floor(viewport.width / dpr)}px`;
        textDiv.style.height = `${Math.floor(viewport.height / dpr)}px`;
        textLayer = new pdfjs.TextLayer({
          textContentSource: pg.streamTextContent(),
          container: textDiv,
          viewport: pg.getViewport({ scale }),
        });
        await textLayer.render();
        if (seq !== renderSeq.current) return;
        setRendering(false);
        onProgress(page, doc.numPages);
      } catch (e) {
        if (seq === renderSeq.current && !(e instanceof Error && e.name === 'RenderingCancelledException')) {
          setRendering(false);
        }
      }
    })();
    return () => {
      renderTask?.cancel();
      textLayer?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, zoom]);

  /* ---------- 锚点定位（回到原文） ---------- */
  useEffect(() => {
    if (!doc || !anchorText) return;
    const needle = anchorText.replace(/\s+/g, '').slice(0, 40);
    if (!needle) {
      onAnchorConsumed?.();
      return;
    }
    let cancelled = false;
    (async () => {
      for (let p = 1; p <= doc.numPages; p++) {
        if (cancelled) return;
        try {
          const pg = await doc.getPage(p);
          const tc = await pg.getTextContent();
          const hay = (tc.items as { str?: string }[]).map((i) => i.str ?? '').join('').replace(/\s+/g, '');
          if (hay.includes(needle)) {
            setPage(p);
            break;
          }
        } catch {
          /* 跳过无法读取的页 */
        }
      }
      onAnchorConsumed?.();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, anchorText]);

  /* ---------- 键盘翻页 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(1, p - 1));
      if (e.key === 'ArrowRight') setPage((p) => Math.min(pageCount || p, p + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageCount]);

  /* ---------- 划选 ---------- */
  const handleMouseUp = useCallback(() => {
    const textDiv = textLayerRef.current;
    if (!textDiv) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if (!textDiv.contains(sel.anchorNode)) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    onSelectText({
      text,
      page,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  }, [onSelectText, page]);

  const gotoPage = (p: number) => {
    if (!pageCount) return;
    setPage(Math.min(Math.max(1, p), pageCount));
  };

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{error}</p>
        <p className="text-xs">可在书架的书籍菜单中切换回「重排文本」模式阅读。</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* 工具条 */}
      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
        <button
          onClick={() => setTocOpen((v) => !v)}
          className={`rounded p-1.5 hover:bg-accent ${tocOpen ? 'bg-accent text-primary' : 'text-muted-foreground'}`}
          title="页面大纲"
        >
          <ListTree size={15} />
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button onClick={() => gotoPage(page - 1)} disabled={page <= 1} className="rounded p-1.5 hover:bg-accent disabled:opacity-30" title="上一页">
          <ChevronLeft size={15} />
        </button>
        <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
          <input
            value={pageInput}
            placeholder={String(page)}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pageInput) {
                gotoPage(parseInt(pageInput, 10));
                setPageInput('');
              }
            }}
            onBlur={() => setPageInput('')}
            className="w-10 rounded border border-border bg-transparent px-1 py-0.5 text-center text-foreground outline-none focus:border-primary/60"
          />
          <span>/ {pageCount || '…'}</span>
        </div>
        <button
          onClick={() => gotoPage(page + 1)}
          disabled={page >= pageCount}
          className="rounded p-1.5 hover:bg-accent disabled:opacity-30"
          title="下一页"
        >
          <ChevronRight size={15} />
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(1)))} className="rounded p-1.5 hover:bg-accent" title="缩小">
          <ZoomOut size={15} />
        </button>
        <span className="w-11 text-center text-[11px] text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))} className="rounded p-1.5 hover:bg-accent" title="放大">
          <ZoomIn size={15} />
        </button>
        {rendering && <Loader2 size={13} className="ml-2 animate-spin text-muted-foreground" />}
        <span className="ml-auto text-[10.5px] text-muted-foreground/70">原版版面</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 大纲侧栏 */}
        {tocOpen && (
          <div className="w-56 shrink-0 overflow-y-auto border-r border-border/60 py-2">
            {toc.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">该 PDF 没有页面大纲。</p>
            )}
            {toc.map((t, i) => (
              <button
                key={i}
                onClick={() => t.page > 0 && gotoPage(t.page)}
                className={`block w-full truncate px-3 py-1 text-left text-[12px] hover:bg-accent ${
                  t.page === page ? 'text-primary' : 'text-foreground/80'
                }`}
                style={{ paddingLeft: 12 + t.depth * 14 }}
                title={t.title}
              >
                {t.title}
                {t.page > 0 && <span className="ml-1 text-[10px] text-muted-foreground">p.{t.page}</span>}
              </button>
            ))}
          </div>
        )}

        {/* 页面区 */}
        <div ref={containerRef} className="flex-1 overflow-auto bg-muted/30" onMouseUp={handleMouseUp}>
          <div className="flex justify-center px-6 py-6">
            <div className="relative shadow-lg">
              <canvas ref={canvasRef} className="block bg-white" />
              <div ref={textLayerRef} className="textLayer absolute inset-0" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
