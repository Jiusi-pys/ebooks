import { initFb2File } from "@lingo-reader/fb2-parser";
import type { ParsedBook } from "./parseBook";
import { coverResourceToDataUrl, extractHtmlBookChapters } from "./ebookText";
import { mirrorSafeBookField } from "./parseMetadataField";

const MAX_FB2_BYTES = 128 * 1024 * 1024;

function fb2Encoding(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";

  const header = String.fromCharCode(...bytes.subarray(0, 512)).replaceAll(
    "\0",
    ""
  );
  return header.match(/<\?xml[^>]*encoding=["']\s*([^"']+)/i)?.[1] ?? "utf-8";
}

const UNUSED_INIT_RESOURCE =
  /<((?:[A-Za-z_][\w.-]*:)?(?:stylesheet|history))\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const UNUSED_INIT_RESOURCE_EMPTY =
  /<(?:[A-Za-z_][\w.-]*:)?(?:stylesheet|history)\b[^>]*\/\s*>/gi;
const FB2_BODY = /<((?:[A-Za-z_][\w.-]*:)?body)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const XML_ANGLE_ENTITY = /&(?:lt|gt|#0*(?:60|62)|#x0*(?:3c|3e));/g;

/**
 * Remove metadata resources that this text-only importer never consumes.
 * lingo-reader creates URLs for these during initialization, before a failed
 * init can return a parser instance for cleanup. Escaped angle brackets are
 * protected for one extra decode/serialize cycle so code samples stay text.
 */
export function prepareFb2Xml(xml: string): string {
  const withoutUnusedResources = xml
    .replace(UNUSED_INIT_RESOURCE, "")
    .replace(UNUSED_INIT_RESOURCE_EMPTY, "");
  return withoutUnusedResources.replace(FB2_BODY, body =>
    body.replace(XML_ANGLE_ENTITY, entity => `&amp;${entity.slice(1)}`)
  );
}

/** Normalize FB2 XML to a browser File; the upstream browser parser expects text for this path. */
function normalizedFb2File(file: File, bytes: Uint8Array): File {
  const encoding = fb2Encoding(bytes);
  try {
    const xml = new TextDecoder(encoding, { fatal: true })
      .decode(bytes)
      .replace(/^\ufeff/, "");
    return new File([prepareFb2Xml(xml)], file.name, {
      type: "application/xml",
    });
  } catch (error) {
    throw new Error(`无法按 ${encoding} 解码 FB2 文件：${errorDetail(error)}`, {
      cause: error,
    });
  }
}

function fileTitle(file: File): string {
  return file.name.replace(/\.fb2$/i, "");
}

function authorName(author: {
  name?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
}): string {
  return (
    author.name?.trim() ||
    [author.firstName, author.middleName, author.lastName]
      .map(part => part?.trim())
      .filter(Boolean)
      .join(" ")
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 180)
    : "未知解析错误";
}

export async function parseFb2(
  file: File,
  onProgress?: (stage: string, ratio: number) => void
): Promise<ParsedBook> {
  if (file.size === 0) throw new Error("FB2 文件为空");
  if (file.size > MAX_FB2_BYTES) throw new Error("FB2 文件不能超过 128 MB");

  onProgress?.("读取 FB2 文件", 0.04);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let parser: Awaited<ReturnType<typeof initFb2File>> | undefined;

  try {
    onProgress?.("读取 FB2 书目信息", 0.1);
    parser = await initFb2File(normalizedFb2File(file, bytes));
    const metadata = parser.getMetadata();
    const title = mirrorSafeBookField(
      metadata.title?.trim() || metadata.bookName?.trim() || fileTitle(file)
    );
    const author = mirrorSafeBookField(
      metadata.author ? authorName(metadata.author) : ""
    );

    let cover: string | undefined;
    try {
      cover = await coverResourceToDataUrl(parser.getCoverImage());
    } catch {
      // A broken optional cover must not prevent importing readable text.
    }
    const chapters = extractHtmlBookChapters(parser, (completed, total) => {
      onProgress?.(
        "解析 FB2 章节",
        0.18 + 0.78 * (completed / Math.max(total, 1))
      );
    });
    if (chapters.length === 0) throw new Error("未能从 FB2 文件中识别出正文");

    onProgress?.("完成导入", 1);
    return { title, author, cover, chapters };
  } catch (error) {
    if (
      error instanceof Error &&
      /(?:不能超过|已停止导入|文件为空|未能从)/.test(error.message)
    ) {
      throw error;
    }
    throw new Error(`未能解析 FB2 文件：${errorDetail(error)}`, {
      cause: error,
    });
  } finally {
    parser?.destroy();
  }
}
