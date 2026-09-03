import type { Highlight, PdfAnchorRect, PdfHighlightAnchor } from "@/types";

export const MAX_PDF_ANCHOR_RECTS = 256;

/** DOMRect 的最小可测试形状，避免纯函数测试依赖浏览器 DOM。 */
export interface PdfRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
}

export interface PdfPageAnnotation {
  highlight: Highlight;
  rects: PdfAnchorRect[];
}

export interface PdfAssociationBadgeAnchor {
  key: string;
  anchor: PdfHighlightAnchor;
}

const roundCoordinate = (value: number) =>
  Math.round(value * 1_000_000) / 1_000_000;

function finiteRect(rect: PdfAnchorRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

/**
 * 将 Range.getClientRects() 产生的视口矩形裁剪到 PDF 页面，
 * 并转换为与缩放无关的 0..1 坐标。
 */
export function normalizePdfSelectionRects(
  rects: ArrayLike<PdfRectLike>,
  pageRect: PdfRectLike
): PdfAnchorRect[] {
  if (
    !Number.isFinite(pageRect.left) ||
    !Number.isFinite(pageRect.top) ||
    !Number.isFinite(pageRect.width) ||
    !Number.isFinite(pageRect.height) ||
    pageRect.width <= 0 ||
    pageRect.height <= 0
  ) {
    return [];
  }

  const pageRight = pageRect.left + pageRect.width;
  const pageBottom = pageRect.top + pageRect.height;
  const normalized: PdfAnchorRect[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < Math.min(rects.length, MAX_PDF_ANCHOR_RECTS); i++) {
    const rect = rects[i];
    if (
      !rect ||
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue;
    }

    const rectRight = Number.isFinite(rect.right)
      ? (rect.right as number)
      : rect.left + rect.width;
    const rectBottom = Number.isFinite(rect.bottom)
      ? (rect.bottom as number)
      : rect.top + rect.height;
    const left = Math.max(pageRect.left, rect.left);
    const top = Math.max(pageRect.top, rect.top);
    const right = Math.min(pageRight, rectRight);
    const bottom = Math.min(pageBottom, rectBottom);
    if (right <= left || bottom <= top) continue;

    const value: PdfAnchorRect = {
      x: roundCoordinate((left - pageRect.left) / pageRect.width),
      y: roundCoordinate((top - pageRect.top) / pageRect.height),
      width: roundCoordinate((right - left) / pageRect.width),
      height: roundCoordinate((bottom - top) / pageRect.height),
    };
    const key = `${value.x}:${value.y}:${value.width}:${value.height}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(value);
    }
  }

  return normalized;
}

/** 丢弃损坏或越界的持久化矩形，并将边缘轻微越界的旧数据裁回页内。 */
export function sanitizePdfAnchorRects(
  rects: readonly PdfAnchorRect[]
): PdfAnchorRect[] {
  const sanitized: PdfAnchorRect[] = [];
  for (const rect of rects.slice(0, MAX_PDF_ANCHOR_RECTS)) {
    if (!finiteRect(rect) || rect.width <= 0 || rect.height <= 0) continue;
    const left = Math.max(0, Math.min(1, rect.x));
    const top = Math.max(0, Math.min(1, rect.y));
    const right = Math.max(left, Math.min(1, rect.x + rect.width));
    const bottom = Math.max(top, Math.min(1, rect.y + rect.height));
    if (right <= left || bottom <= top) continue;
    sanitized.push({
      x: roundCoordinate(left),
      y: roundCoordinate(top),
      width: roundCoordinate(right - left),
      height: roundCoordinate(bottom - top),
    });
  }
  return sanitized;
}

export function createPdfHighlightAnchor(
  page: number,
  rects: ArrayLike<PdfRectLike>,
  pageRect: PdfRectLike
): PdfHighlightAnchor | null {
  if (!Number.isInteger(page) || page < 1) return null;
  const normalized = normalizePdfSelectionRects(rects, pageRect);
  return normalized.length > 0 ? { page, rects: normalized } : null;
}

/** 只返回当前页能安全渲染的注释。 */
export function pdfAnnotationsForPage(
  highlights: readonly Highlight[],
  page: number
): PdfPageAnnotation[] {
  if (!Number.isInteger(page) || page < 1) return [];
  const annotations: PdfPageAnnotation[] = [];
  for (const highlight of highlights) {
    if (highlight.pdfAnchor?.page !== page) continue;
    const rects = sanitizePdfAnchorRects(highlight.pdfAnchor.rects);
    if (rects.length > 0) annotations.push({ highlight, rects });
  }
  return annotations;
}

/** 在页内归一化坐标处找到最上层的注释。 */
export function findPdfAnnotationAtPoint(
  annotations: readonly PdfPageAnnotation[],
  x: number,
  y: number
): Highlight | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const annotation of annotations) {
    if (
      annotation.rects.some(
        rect =>
          x >= rect.x &&
          x <= rect.x + rect.width &&
          y >= rect.y &&
          y <= rect.y + rect.height
      )
    ) {
      return annotation.highlight;
    }
  }
  return null;
}

/** Give badges sharing the same visual endpoint a stable vertical stack. */
export function stackPdfAssociationBadges<T extends PdfAssociationBadgeAnchor>(
  items: readonly T[]
): Array<
  T & {
    badgeX: number;
    badgeY: number;
    stackIndex: number;
    stackDirection: "up" | "down";
  }
> {
  const occupied = new Map<string, number>();
  return items.map(item => {
    const last = item.anchor.rects[item.anchor.rects.length - 1];
    const badgeX = last
      ? roundCoordinate(Math.min(0.985, last.x + last.width))
      : 0;
    const badgeY = last
      ? roundCoordinate(
          Math.max(0.02, Math.min(0.98, last.y + last.height / 2))
        )
      : 0.02;
    const endpoint = `${badgeX}:${badgeY}`;
    const stackIndex = occupied.get(endpoint) ?? 0;
    occupied.set(endpoint, stackIndex + 1);
    return {
      ...item,
      badgeX,
      badgeY,
      stackIndex,
      stackDirection: badgeY < 0.15 ? "down" : "up",
    };
  });
}
