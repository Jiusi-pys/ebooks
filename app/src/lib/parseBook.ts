import type { BookMetadata, Chapter, OutlineItem } from "@/types";
import type { ImportBookFormat } from "./bookFormats";
// Keep every parser eager: an open production tab must not request a removed
// hashed parser chunk after the app is rebuilt in place.
import { parseEpub } from "./parseEpub";
import { parseFb2 } from "./parseFb2";
import { parseMobi } from "./parseMobi";
import { parsePdf } from "./parsePdf";
import { parseTxt } from "./parseTxt";

export interface ParsedBook {
  title: string;
  author: string;
  cover?: string;
  chapters: Chapter[];
  outline?: OutlineItem[];
  /** 原始 PDF 总页数；其他格式为 undefined。 */
  pageCount?: number;
  /** 从书籍文件安全提取并归一化的可编辑书目元数据。 */
  metadata?: BookMetadata;
}

export interface ParseBookOptions {
  /**
   * Original-layout PDFs only need their metadata, page count and cover during
   * import. Skipping text extraction keeps a valid large/scanned PDF usable.
   */
  pdfMode?: "reflow" | "original";
}

export async function parseBookFile(
  file: File,
  format: ImportBookFormat,
  onProgress?: (stage: string, ratio: number) => void,
  options: ParseBookOptions = {}
): Promise<ParsedBook> {
  switch (format) {
    case "pdf":
      return parsePdf(file, onProgress, options.pdfMode);
    case "epub":
      return parseEpub(file, onProgress);
    case "mobi":
    case "azw3":
      return parseMobi(file, format, onProgress);
    case "fb2":
      return parseFb2(file, onProgress);
    case "txt":
      return parseTxt(file, onProgress);
  }
}
