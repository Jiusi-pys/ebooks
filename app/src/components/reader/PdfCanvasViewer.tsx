import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Link2,
  ListTree,
  Loader2,
  Quote,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { openPdfDocument, pdfjs } from "@/lib/pdfjs";
import { getFile } from "@/lib/db";
import {
  createPdfHighlightAnchor,
  findPdfAnnotationAtPoint,
  pdfAnnotationsForPage,
  stackPdfAssociationBadges,
} from "@/lib/pdfAnnotations";
import { swatch } from "@/lib/reading";
import type { Highlight, PdfAnchorRect, PdfHighlightAnchor } from "@/types";
import "pdfjs-dist/web/pdf_viewer.css";

type PdfDoc = pdfjs.PDFDocumentProxy;

interface TocEntry {
  title: string;
  page: number;
  depth: number;
}

export interface PdfSelectInfo {
  text: string;
  page: number;
  /** 页内归一化多行矩形，可直接持久化为 Highlight.pdfAnchor。 */
  rects: PdfAnchorRect[];
  /** 视口坐标（用于 fixed 定位弹层） */
  x: number;
  y: number;
}

export interface PdfCanvasViewerProps {
  bookId: string;
  initialPage: number;
  onProgress: (page: number, pageCount: number) => void;
  onSelectText: (info: PdfSelectInfo) => void;
  /** 当前书籍的书摘；只渲染其中带 pdfAnchor 的当前页记录。 */
  highlights?: readonly Highlight[];
  /** 点击页内划线或批注角标。x/y 是视口坐标。 */
  onHighlightClick?: (highlight: Highlight, x: number, y: number) => void;
  /** 已知页码时优先直接定位，避免逐页搜索相同文字。 */
  anchorPage?: number | null;
  /** 设置后跳转至包含该文字的页（兼容旧书摘）。 */
  anchorText?: string | null;
  onAnchorConsumed?: () => void;
  /** 翻页或缩放时通知宿主关闭浮动选区工具条。 */
  onSelectionClear?: () => void;
  /** 独立“关联”端点；不要求先创建 Highlight。 */
  associationAnchors?: readonly {
    key: string;
    anchor: PdfHighlightAnchor;
    count: number;
  }[];
  onAssociationClick?: (key: string, x: number, y: number) => void;
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
  highlights = [],
  onHighlightClick,
  anchorPage,
  anchorText,
  onAnchorConsumed,
  onSelectionClear,
  associationAnchors = [],
  onAssociationClick,
}: PdfCanvasViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderSeq = useRef(0);
  const onSelectionClearRef = useRef(onSelectionClear);

  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(Math.max(1, initialPage));
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [pageInput, setPageInput] = useState("");
  const pageAnnotations = useMemo(
    () => pdfAnnotationsForPage(highlights, page),
    [highlights, page]
  );
  const pageAssociations = useMemo(
    () =>
      stackPdfAssociationBadges(
        associationAnchors.filter(item => item.anchor.page === page)
      ),
    [associationAnchors, page]
  );

  useEffect(() => {
    onSelectionClearRef.current = onSelectionClear;
  }, [onSelectionClear]);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    onSelectionClearRef.current?.();
  }, []);

  useEffect(() => {
    clearSelection();
  }, [page, zoom, clearSelection]);

  /* ---------- 加载文档 ---------- */
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    (async () => {
      const f = await getFile(bookId);
      if (!f) {
        setError("未找到原始 PDF 文件（可能是旧版本导入的书籍）。");
        return;
      }
      try {
        // Blob 是新导入格式；ArrayBuffer 分支兼容既有 IndexedDB 数据。
        // 两者都生成独立 buffer，避免 pdfjs 的 worker 转移影响持久化值。
        const data =
          f.data instanceof Blob ? await f.data.arrayBuffer() : f.data.slice(0);
        loadingTask = openPdfDocument(data);
        const loaded = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        setDoc(loaded);
        setPageCount(loaded.numPages);
        setPage(p => Math.min(Math.max(1, p), loaded!.numPages));
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "PDF 加载失败");
      }
    })();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [bookId]);

  /* ---------- 大纲 ---------- */
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const out: TocEntry[] = [];
    const walk = async (
      items: Awaited<ReturnType<PdfDoc["getOutline"]>>,
      depth: number
    ) => {
      for (const it of items ?? []) {
        let pageNum = 0;
        try {
          if (it.dest) {
            const dest =
              typeof it.dest === "string"
                ? await doc.getDestination(it.dest)
                : (it.dest as unknown[]);
            if (Array.isArray(dest) && dest[0]) {
              pageNum =
                (await doc.getPageIndex(
                  dest[0] as Parameters<PdfDoc["getPageIndex"]>[0]
                )) + 1;
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
        const fit =
          el && el.clientWidth > 0
            ? (el.clientWidth - 48) / base.width
            : fitScale;
        if (Math.abs(fit - fitScale) > 0.01) setFitScale(fit);
        const scale = fit * zoom;
        const dpr = window.devicePixelRatio || 1;
        const viewport = pg.getViewport({ scale: scale * dpr });
        const textViewport = pg.getViewport({ scale });

        const canvas = canvasRef.current;
        const textDiv = textLayerRef.current;
        if (!canvas || !textDiv) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        renderTask = pg.render({ canvas, canvasContext: ctx, viewport });
        await renderTask.promise;
        if (seq !== renderSeq.current) return;

        // 文本层（用于划选）
        textDiv.innerHTML = "";
        // PDF.js 的 TextLayer CSS 通常从 `.pdfViewer .page` 继承这些变量。
        // 本组件使用轻量自定义 DOM，因此需要显式提供，否则文字命中框会错位。
        textDiv.style.setProperty("--scale-factor", String(scale));
        textDiv.style.setProperty("--user-unit", "1");
        textDiv.style.setProperty("--total-scale-factor", String(scale));
        textDiv.style.setProperty("--scale-round-x", "1px");
        textDiv.style.setProperty("--scale-round-y", "1px");
        textLayer = new pdfjs.TextLayer({
          textContentSource: pg.streamTextContent(),
          container: textDiv,
          viewport: textViewport,
        });
        // TextLayer 构造器会改写宽高为 CSS round() 表达式；显式像素值
        // 可兼容不支持 round() 的浏览器，且与 canvas 可视尺寸完全一致。
        textDiv.style.width = `${Math.floor(viewport.width / dpr)}px`;
        textDiv.style.height = `${Math.floor(viewport.height / dpr)}px`;
        await textLayer.render();
        if (seq !== renderSeq.current) return;
        setRendering(false);
        onProgress(page, doc.numPages);
      } catch (e) {
        if (
          seq === renderSeq.current &&
          !(e instanceof Error && e.name === "RenderingCancelledException")
        ) {
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

  /* ---------- 精确页码锚点（新版 PDF 书摘） ---------- */
  useEffect(() => {
    if (!doc || anchorPage == null) return;
    const target = Number.isFinite(anchorPage)
      ? Math.min(doc.numPages, Math.max(1, Math.trunc(anchorPage)))
      : 1;
    setPage(target);
    onAnchorConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, anchorPage]);

  /* ---------- 锚点定位（回到原文） ---------- */
  useEffect(() => {
    if (!doc || anchorPage != null || !anchorText) return;
    const needle = anchorText.replace(/\s+/g, "").slice(0, 40);
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
          const hay = (tc.items as { str?: string }[])
            .map(i => i.str ?? "")
            .join("")
            .replace(/\s+/g, "");
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
  }, [doc, anchorPage, anchorText]);

  /* ---------- 键盘翻页 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "ArrowLeft") setPage(p => Math.max(1, p - 1));
      if (e.key === "ArrowRight") setPage(p => Math.min(pageCount || p, p + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageCount]);

  /* ---------- 划选 ---------- */
  const handleMouseUp = useCallback(() => {
    const textDiv = textLayerRef.current;
    if (!textDiv) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (
      !textDiv.contains(range.startContainer) ||
      !textDiv.contains(range.endContainer)
    )
      return;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (text.length < 2) return;
    const anchor = createPdfHighlightAnchor(
      page,
      range.getClientRects(),
      textDiv.getBoundingClientRect()
    );
    if (!anchor) return;
    const rect = range.getBoundingClientRect();
    onSelectText({
      text,
      page,
      rects: anchor.rects,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  }, [onSelectText, page]);

  const handleTextLayerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onHighlightClick || !window.getSelection()?.isCollapsed) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const hit = findPdfAnnotationAtPoint(
        pageAnnotations.filter(
          annotation =>
            (annotation.highlight.style?.kind ?? "underline") !== "none" ||
            !!annotation.highlight.note
        ),
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height
      );
      if (hit) onHighlightClick(hit, event.clientX, event.clientY);
    },
    [onHighlightClick, pageAnnotations]
  );

  const gotoPage = (p: number) => {
    if (!pageCount) return;
    setPage(Math.min(Math.max(1, p), pageCount));
  };

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{error}</p>
        <p className="text-xs">
          可在书架的书籍菜单中切换回「重排文本」模式阅读。
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* 工具条 */}
      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
        <button
          onClick={() => setTocOpen(v => !v)}
          className={`rounded p-1.5 hover:bg-accent ${tocOpen ? "bg-accent text-primary" : "text-muted-foreground"}`}
          title="页面大纲"
        >
          <ListTree size={15} />
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          onClick={() => gotoPage(page - 1)}
          disabled={page <= 1}
          className="rounded p-1.5 hover:bg-accent disabled:opacity-30"
          title="上一页"
        >
          <ChevronLeft size={15} />
        </button>
        <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
          <input
            value={pageInput}
            placeholder={String(page)}
            onChange={e => setPageInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={e => {
              if (e.key === "Enter" && pageInput) {
                gotoPage(parseInt(pageInput, 10));
                setPageInput("");
              }
            }}
            onBlur={() => setPageInput("")}
            className="w-10 rounded border border-border bg-transparent px-1 py-0.5 text-center text-foreground outline-none focus:border-primary/60"
          />
          <span>/ {pageCount || "…"}</span>
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
        <button
          onClick={() => setZoom(z => Math.max(0.5, +(z - 0.2).toFixed(1)))}
          className="rounded p-1.5 hover:bg-accent"
          title="缩小"
        >
          <ZoomOut size={15} />
        </button>
        <span className="w-11 text-center text-[11px] text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom(z => Math.min(3, +(z + 0.2).toFixed(1)))}
          className="rounded p-1.5 hover:bg-accent"
          title="放大"
        >
          <ZoomIn size={15} />
        </button>
        {rendering && (
          <Loader2
            size={13}
            className="ml-2 animate-spin text-muted-foreground"
          />
        )}
        <span className="ml-auto text-[10.5px] text-muted-foreground/70">
          原版版面
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 大纲侧栏 */}
        {tocOpen && (
          <div className="w-56 shrink-0 overflow-y-auto border-r border-border/60 py-2">
            {toc.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                该 PDF 没有页面大纲。
              </p>
            )}
            {toc.map((t, i) => (
              <button
                key={i}
                onClick={() => t.page > 0 && gotoPage(t.page)}
                className={`block w-full truncate px-3 py-1 text-left text-[12px] hover:bg-accent ${
                  t.page === page ? "text-primary" : "text-foreground/80"
                }`}
                style={{ paddingLeft: 12 + t.depth * 14 }}
                title={t.title}
              >
                {t.title}
                {t.page > 0 && (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    p.{t.page}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* 页面区 */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto bg-muted/30"
          onMouseUp={handleMouseUp}
        >
          <div className="flex justify-center px-6 py-6">
            <div className="relative shadow-lg" data-pdf-page={page}>
              <canvas ref={canvasRef} className="block bg-white" />

              {/* 持久化划线层：归一化坐标会随页面一起缩放。 */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{ zIndex: 1 }}
              >
                {pageAnnotations.flatMap(({ highlight, rects }) => {
                  const kind = highlight.style?.kind ?? "underline";
                  if (kind === "none" && !highlight.noteId) return [];
                  const color = swatch(highlight.style?.color ?? "orange");
                  return rects.map((rect, index) => (
                    <div
                      key={`${highlight.id}:${index}`}
                      data-pdf-highlight-id={highlight.id}
                      className="absolute rounded-[2px]"
                      style={{
                        left: `${rect.x * 100}%`,
                        top: `${rect.y * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`,
                        backgroundColor: highlight.noteId
                          ? "rgba(245, 64, 1, 0.14)"
                          : kind === "background"
                            ? color.soft
                            : undefined,
                        borderBottom: highlight.noteId
                          ? "1px dashed #f54001"
                          : kind === "underline" || kind === "color"
                            ? `2px solid ${color.solid}`
                            : undefined,
                        boxSizing: "border-box",
                        mixBlendMode: "multiply",
                      }}
                    />
                  ));
                })}
              </div>

              {/* 关联端点与书摘/引用独立显示。 */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{ zIndex: 1 }}
              >
                {pageAssociations.flatMap(item =>
                  item.anchor.rects.map((rect, index) => (
                    <div
                      key={`${item.key}:${index}`}
                      data-pdf-association-key={item.key}
                      className="absolute rounded-[2px] border-b-2 border-dashed border-sky-600 bg-sky-400/15"
                      style={{
                        left: `${rect.x * 100}%`,
                        top: `${rect.y * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`,
                        boxSizing: "border-box",
                        mixBlendMode: "multiply",
                      }}
                    />
                  ))
                )}
              </div>

              <div
                ref={textLayerRef}
                className="textLayer absolute inset-0"
                style={{ zIndex: 2 }}
                onClick={handleTextLayerClick}
              />

              {/* 批注角标独立置于文本层上方，不阻断其他文字划选。 */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{ zIndex: 3 }}
              >
                {pageAnnotations.map(({ highlight, rects }) => {
                  if (!highlight.note && !highlight.noteId) return null;
                  const last = rects[rects.length - 1];
                  return (
                    <button
                      key={`note:${highlight.id}`}
                      type="button"
                      className="pointer-events-auto absolute flex h-[18px] min-w-[18px] -translate-y-1/2 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground shadow"
                      style={{
                        left: `${Math.min(1, last.x + last.width) * 100}%`,
                        top: `${Math.min(1, last.y + last.height / 2) * 100}%`,
                      }}
                      title={highlight.noteId ? "管理引用" : highlight.note}
                      aria-label={
                        highlight.noteId
                          ? `管理引用：${highlight.text.slice(0, 30)}`
                          : `打开批注：${highlight.note?.slice(0, 30) ?? ""}`
                      }
                      onMouseDown={event => event.preventDefault()}
                      onClick={event => {
                        event.stopPropagation();
                        onHighlightClick?.(
                          highlight,
                          event.clientX,
                          event.clientY
                        );
                      }}
                    >
                      {highlight.noteId ? <Quote size={10} /> : "注"}
                    </button>
                  );
                })}
              </div>

              {/* 关联球：点击预览，面板内可精确跳转或删除。 */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{ zIndex: 4 }}
              >
                {pageAssociations.map(item => {
                  const last = item.anchor.rects[item.anchor.rects.length - 1];
                  if (!last) return null;
                  return (
                    <button
                      key={`association:${item.key}`}
                      type="button"
                      className="pointer-events-auto absolute flex h-[19px] min-w-[19px] items-center justify-center gap-0.5 rounded-full bg-sky-700 px-1 text-[9px] font-medium text-white shadow"
                      style={{
                        left: `${item.badgeX * 100}%`,
                        top: `${item.badgeY * 100}%`,
                        transform:
                          item.stackDirection === "down"
                            ? `translate(4px, calc(25% + ${
                                item.stackIndex * 22
                              }px))`
                            : `translate(4px, calc(-125% - ${
                                item.stackIndex * 22
                              }px))`,
                      }}
                      title={`${item.count} 条内容关联`}
                      aria-label={`管理 ${item.count} 条内容关联`}
                      onMouseDown={event => event.preventDefault()}
                      onClick={event => {
                        event.stopPropagation();
                        onAssociationClick?.(
                          item.key,
                          event.clientX,
                          event.clientY
                        );
                      }}
                    >
                      <Link2 size={10} />
                      {item.count > 1 ? item.count : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
