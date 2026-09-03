import * as pdfjs from "pdfjs-dist";

/**
 * worker 走 public/ 下的固定路径：
 * `?url` 资源引用在开发模式下会生成 /node_modules/...?import 形式的 URL，
 * 在部署预览环境中无法加载，导致 "Setting up fake worker failed"。
 * public/pdf.worker.min.mjs 由 Vite 原样拷贝到 dist/public 根目录，
 * 开发与生产环境都是同源稳定路径。
 */
pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

/** Shared loading-task factory for text extraction and canvas rendering. */
export function openPdfDocument(data: ArrayBuffer | Uint8Array) {
  return pdfjs.getDocument({
    data,
    // Let PDF.js downsample oversized images to this canvas-memory budget.
    // `maxImageSize` is intentionally omitted because it drops high-DPI scans.
    canvasMaxAreaInBytes: 64 * 1024 * 1024,
  });
}

export { pdfjs };
