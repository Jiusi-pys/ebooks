import type { EpubFootnote } from "@/types";

/** Local presentation sidecar; never extend the synchronized Chapter contract. */
export type EpubParagraphRole = "caption" | "credit" | "image-note";
export type EpubLayoutRole = EpubParagraphRole;
export type EpubLayoutNote = Omit<EpubFootnote, "paraIndex">;

export interface EpubInlineImage {
  /** UTF-16 offset into the existing, normalized paragraph. */
  offset: number;
  /** Preserve source order when several images share a text offset. */
  order: number;
  assetId: string;
  alt: string;
}

export interface EpubParagraphItem {
  kind: "paragraph";
  paraIndex: number;
  role?: EpubParagraphRole;
  inlineImages?: EpubInlineImage[];
}

export interface EpubImageItem {
  kind: "image";
  assetId: string;
  alt: string;
}

export interface EpubTextItem {
  kind: "text";
  text: string;
  notes: EpubLayoutNote[];
  role?: EpubParagraphRole;
}

export type EpubFigureChild = EpubParagraphItem | EpubImageItem | EpubTextItem;

export interface EpubFigureItem {
  kind: "figure";
  items: EpubFigureChild[];
}

export type EpubLayoutItem = EpubFigureChild | EpubFigureItem;

export interface EpubChapterLayout {
  items: EpubLayoutItem[];
}

export interface EpubImageAsset {
  dataUrl: string;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface EpubLayout {
  version: 1;
  assets: Record<string, EpubImageAsset>;
  chapters: Record<string, EpubChapterLayout>;
}

export const EPUB_IMAGE_LIMITS = {
  imageBytes: 12 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  count: 2000,
  dimension: 16384,
  pixels: 40_000_000,
} as const;

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function dimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > EPUB_IMAGE_LIMITS.dimension ||
    height > EPUB_IMAGE_LIMITS.dimension ||
    width * height > EPUB_IMAGE_LIMITS.pixels
  )
    throw new Error("EPUB 图片尺寸或像素数超过限制");
}

/** Inspect bounded raster headers before asking the browser to decode pixels. */
export function inspectEpubImage(bytes: Uint8Array): {
  mediaType: string;
  width: number;
  height: number;
} {
  if (bytes.byteLength > EPUB_IMAGE_LIMITS.imageBytes)
    throw new Error("EPUB 单张图片超过 12 MiB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, count: number) =>
    String.fromCharCode(...bytes.subarray(start, start + count));
  let mediaType = "";
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
    view.getUint32(8) === 13 &&
    ascii(12, 4) === "IHDR"
  ) {
    mediaType = "image/png";
    width = view.getUint32(16);
    height = view.getUint32(20);
    dimensions(width, height);
    let end = false;
    let imageData = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset);
      const type = ascii(offset + 4, 4);
      if (offset + 12 + size > bytes.length) break;
      if (type === "IDAT") imageData = true;
      offset += 12 + size;
      if (type === "IEND" && size === 0 && offset === bytes.length) {
        end = true;
        break;
      }
    }
    if (!end || !imageData) throw new Error("EPUB PNG 图片内容损坏");
  } else if (
    bytes.length >= 14 &&
    ["GIF87a", "GIF89a"].includes(ascii(0, 6)) &&
    bytes[bytes.length - 1] === 0x3b
  ) {
    mediaType = "image/gif";
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (
    bytes.length >= 12 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 4) === "WEBP" &&
    view.getUint32(4, true) + 8 === bytes.length
  ) {
    mediaType = "image/webp";
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = ascii(offset, 4);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + size > bytes.length)
        throw new Error("EPUB WebP 图片内容损坏");
      if (type === "VP8X" && size >= 10) {
        width =
          1 +
          bytes[start + 4] +
          (bytes[start + 5] << 8) +
          (bytes[start + 6] << 16);
        height =
          1 +
          bytes[start + 7] +
          (bytes[start + 8] << 8) +
          (bytes[start + 9] << 16);
        break;
      }
      if (type === "VP8L" && size >= 5 && bytes[start] === 0x2f) {
        const bits = view.getUint32(start + 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        break;
      }
      if (
        type === "VP8 " &&
        size >= 10 &&
        ascii(start + 3, 3) === "\x9d\x01\x2a"
      ) {
        width = view.getUint16(start + 6, true) & 0x3fff;
        height = view.getUint16(start + 8, true) & 0x3fff;
        break;
      }
      offset = start + size + (size % 2);
    }
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  ) {
    mediaType = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        size >= 8
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += size;
    }
  }
  if (!mediaType) throw new Error("EPUB 图片不是支持的 PNG/JPEG/GIF/WebP 格式");
  dimensions(width, height);
  return { mediaType, width, height };
}

function imageDataUrl(bytes: Uint8Array, type: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return `data:${type};base64,${btoa(binary)}`;
}

/** No fetch, SVG execution, object URL persistence, or HTML is involved. */
export async function readEpubImage(
  bytes: Uint8Array
): Promise<EpubImageAsset> {
  const info = inspectEpubImage(bytes);
  const dataUrl = imageDataUrl(bytes, info.mediaType);
  let width: number;
  let height: number;
  try {
    if (typeof createImageBitmap === "function") {
      const copy = bytes.slice().buffer;
      const bitmap = await createImageBitmap(
        new Blob([copy], { type: info.mediaType })
      );
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } else {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("图片解码超时")),
          10000
        );
        image.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        image.onerror = () => {
          clearTimeout(timer);
          reject(new Error("图片解码失败"));
        };
        image.src = dataUrl;
      });
      width = image.naturalWidth;
      height = image.naturalHeight;
    }
  } catch {
    throw new Error("EPUB 图片无法在本地解码");
  }
  dimensions(width, height);
  if (!(
    (width === info.width && height === info.height) ||
    (width === info.height && height === info.width)
  ))
    throw new Error("EPUB 图片尺寸与实际解码结果不符");
  return { dataUrl, mediaType: info.mediaType, width, height };
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const role = (value: unknown) =>
  value === undefined ||
  ["caption", "credit", "image-note"].includes(value as string);

/** Cheap validation on cache reads: shape, references, and budgets, no decoding. */
export function isEpubLayout(value: unknown): value is EpubLayout {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.assets) ||
    !record(value.chapters)
  )
    return false;
  const assets = value.assets;
  const entries = Object.entries(assets);
  if (
    entries.length > EPUB_IMAGE_LIMITS.count ||
    Object.keys(value.chapters).length > 8000
  )
    return false;
  let bytes = 0;
  let characters = 0;
  for (const [, asset] of entries) {
    if (
      !record(asset) ||
      typeof asset.mediaType !== "string" ||
      !imageTypes.has(asset.mediaType) ||
      typeof asset.dataUrl !== "string"
    )
      return false;
    const prefix = `data:${asset.mediaType};base64,`;
    if (!asset.dataUrl.startsWith(prefix)) return false;
    const data = asset.dataUrl.slice(prefix.length);
    if (!data || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      return false;
    const size =
      (data.length / 4) * 3 -
      (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (
      size > EPUB_IMAGE_LIMITS.imageBytes ||
      (bytes += size) > EPUB_IMAGE_LIMITS.totalBytes
    )
      return false;
    if (asset.width !== undefined || asset.height !== undefined) {
      if (typeof asset.width !== "number" || typeof asset.height !== "number")
        return false;
      try {
        dimensions(asset.width, asset.height);
      } catch {
        return false;
      }
    }
  }
  const image = (item: Record<string, unknown>) =>
    typeof item.assetId === "string" &&
    Object.hasOwn(assets, item.assetId) &&
    typeof item.alt === "string";
  const child = (item: unknown): boolean => {
    if (!record(item) || !role(item.role)) return false;
    if (item.kind === "image") return image(item);
    if (item.kind === "paragraph") {
      if (!nonnegative(item.paraIndex)) return false;
      if (item.inlineImages === undefined) return true;
      return (
        Array.isArray(item.inlineImages) &&
        item.inlineImages.length <= EPUB_IMAGE_LIMITS.count &&
        item.inlineImages.every(
          i =>
            record(i) &&
            image(i) &&
            nonnegative(i.offset) &&
            nonnegative(i.order)
        )
      );
    }
    if (
      item.kind !== "text" ||
      typeof item.text !== "string" ||
      !Array.isArray(item.notes)
    )
      return false;
    characters += item.text.length;
    return (
      item.notes.every(note => {
        if (
          !record(note) ||
          !nonnegative(note.start) ||
          !nonnegative(note.end) ||
          note.end <= note.start ||
          note.end > (item.text as string).length ||
          typeof note.content !== "string"
        )
          return false;
        characters += note.content.length;
        return characters <= 24000000;
      }) && characters <= 24000000
    );
  };
  for (const chapter of Object.values(value.chapters)) {
    if (
      !record(chapter) ||
      !Array.isArray(chapter.items) ||
      chapter.items.length > 50000
    )
      return false;
    const seen = new Set<number>();
    let count = 0;
    for (const item of chapter.items) {
      const children =
        record(item) && item.kind === "figure" ? item.items : [item];
      if (!Array.isArray(children)) return false;
      for (const entry of children) {
        if (++count > 50000 || !child(entry)) return false;
        if (record(entry) && entry.kind === "paragraph") {
          if (seen.has(entry.paraIndex as number)) return false;
          seen.add(entry.paraIndex as number);
        }
      }
    }
  }
  return true;
}
