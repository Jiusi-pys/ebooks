import type { Chapter } from "@/types";
import type { ImportBookFormat } from "./bookFormats";
import { parseEpub } from "./parseEpub";
import { parsePdf } from "./parsePdf";

export interface ParsedBook {
  title: string;
  author: string;
  cover?: string;
  chapters: Chapter[];
  /** 原始 PDF 总页数；其他格式为 undefined。 */
  pageCount?: number;
}

export async function parseBookFile(
  file: File,
  format: ImportBookFormat,
  onProgress?: (stage: string, ratio: number) => void
): Promise<ParsedBook> {
  switch (format) {
    case "pdf":
      return parsePdf(file, onProgress);
    case "epub":
      return parseEpub(file, onProgress);
    case "mobi":
    case "azw3": {
      const { parseMobi } = await import("./parseMobi");
      return parseMobi(file, format, onProgress);
    }
    case "fb2": {
      const { parseFb2 } = await import("./parseFb2");
      return parseFb2(file, onProgress);
    }
    case "txt": {
      const { parseTxt } = await import("./parseTxt");
      return parseTxt(file, onProgress);
    }
  }
}
