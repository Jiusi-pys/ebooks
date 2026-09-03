import { initKf8File, initMobiFile } from "@lingo-reader/mobi-parser";
import type { ParsedBook } from "./parseBook";
import {
  coverResourceToDataUrl,
  extractHtmlBookChapters,
  type HtmlBookParser,
} from "./ebookText";

const MAX_KINDLE_BYTES = 128 * 1024 * 1024;
const MAX_KINDLE_TEXT_BYTES = 24_000_000;
const MAX_PALM_RECORDS = 10_000;
const MAX_TEXT_RECORDS = 8_192;
const MAX_EXTH_RECORDS = 1_024;
const MAX_HUFF_DICTIONARY_ENTRIES = 65_536;
const MAX_HUFF_CODEWORDS = MAX_KINDLE_TEXT_BYTES;
const MAX_HUFF_RECURSION_DEPTH = 256;
const PALM_DATABASE_SIGNATURE_OFFSET = 60;
const PALM_DATABASE_RECORD_COUNT_OFFSET = 76;
const PALM_DATABASE_RECORD_TABLE_OFFSET = 78;
const PALMDOC_TEXT_LENGTH_OFFSET = 4;
const PALMDOC_TEXT_RECORD_COUNT_OFFSET = 8;
const PALMDOC_RECORD_SIZE_OFFSET = 10;
const PALMDOC_ENCRYPTION_OFFSET = 12;
const MOBI_MAGIC_OFFSET = 16;
const MOBI_HEADER_LENGTH_OFFSET = 20;
const MOBI_VERSION_OFFSET = 36;
const MOBI_HUFF_RECORD_OFFSET = 112;
const MOBI_HUFF_RECORD_COUNT_OFFSET = 116;
const MOBI_EXTH_FLAGS_OFFSET = 128;
const MOBI_TRAILING_FLAGS_OFFSET = 240;
const MIN_MOBI_RECORD_BYTES = 248;

interface PalmRecord {
  start: number;
  end: number;
}

interface BookEnvelope {
  compression: number;
  declaredTextLength: number;
  numTextRecords: number;
  recordSize: number;
  trailingFlags: number;
  huffRecord: number;
  numHuffRecords: number;
}

interface HuffDictionaryEntry {
  data: Uint8Array;
  decodedLength?: number;
  visiting?: boolean;
}

interface HuffTableEntry {
  found: boolean;
  codeLength: number;
  value: number;
}

interface HuffLengthDecoder {
  decodedLength(bytes: Uint8Array): number;
}

export type KindleFormat = "mobi" | "azw3";

function invalidEnvelope(): never {
  throw new Error("不是有效的 MOBI/AZW3 文件");
}

function damagedRecords(): never {
  throw new Error("MOBI/AZW3 记录表已损坏");
}

function damagedText(): never {
  throw new Error("MOBI/AZW3 正文压缩数据已损坏");
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) return damagedRecords();
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(
    0,
    false
  );
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) return damagedRecords();
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    false
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return damagedRecords();
  let result = "";
  for (let index = offset; index < offset + length; index += 1) {
    result += String.fromCharCode(bytes[index]);
  }
  return result;
}

function parsePalmRecords(bytes: Uint8Array): PalmRecord[] {
  const count = readUint16(bytes, PALM_DATABASE_RECORD_COUNT_OFFSET);
  if (count === 0) throw new Error("MOBI/AZW3 文件没有正文记录");
  if (count > MAX_PALM_RECORDS) {
    throw new Error(`Kindle 记录数超过 ${MAX_PALM_RECORDS}，已停止导入`);
  }

  const tableEnd = PALM_DATABASE_RECORD_TABLE_OFFSET + count * 8;
  if (tableEnd > bytes.byteLength) return damagedRecords();

  const starts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = readUint32(
      bytes,
      PALM_DATABASE_RECORD_TABLE_OFFSET + index * 8
    );
    if (
      start < tableEnd ||
      start >= bytes.byteLength ||
      (index > 0 && start <= starts[index - 1])
    ) {
      return damagedRecords();
    }
    starts.push(start);
  }

  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? bytes.byteLength,
  }));
}

function parseExthBoundary(
  bytes: Uint8Array,
  record: PalmRecord,
  mobiHeaderLength: number,
  exthFlags: number
): number | undefined {
  if ((exthFlags & 0x40) === 0) return undefined;

  const start = record.start + MOBI_MAGIC_OFFSET + mobiHeaderLength;
  if (start + 12 > record.end || ascii(bytes, start, 4) !== "EXTH") {
    return damagedRecords();
  }
  const length = readUint32(bytes, start + 4);
  const count = readUint32(bytes, start + 8);
  if (
    length < 12 ||
    start + length > record.end ||
    count > length / 8 ||
    count > MAX_EXTH_RECORDS
  ) {
    return damagedRecords();
  }

  let cursor = start + 12;
  let boundary: number | undefined;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 8 > start + length) return damagedRecords();
    const type = readUint32(bytes, cursor);
    const entryLength = readUint32(bytes, cursor + 4);
    if (entryLength < 8 || cursor + entryLength > start + length) {
      return damagedRecords();
    }
    if (type === 121) {
      if (entryLength < 12) return damagedRecords();
      const parsed = readUint32(bytes, cursor + 8);
      // EXTH 121 uses UINT32_MAX to explicitly say that this legacy MOBI has
      // no KF8 companion section. It is a sentinel, not a PalmDB record index.
      boundary = parsed === 0xffffffff ? undefined : parsed;
    }
    cursor += entryLength;
  }
  return boundary;
}

function parseBookEnvelope(
  bytes: Uint8Array,
  records: PalmRecord[],
  recordIndex: number,
  allowBoundary: boolean
): { envelope: BookEnvelope; boundary?: number } {
  const record = records[recordIndex];
  if (!record || record.end - record.start < MIN_MOBI_RECORD_BYTES) {
    return damagedRecords();
  }
  if (ascii(bytes, record.start + MOBI_MAGIC_OFFSET, 4) !== "MOBI") {
    return invalidEnvelope();
  }

  const mobiHeaderLength = readUint32(
    bytes,
    record.start + MOBI_HEADER_LENGTH_OFFSET
  );
  if (
    mobiHeaderLength < 116 ||
    record.start + MOBI_MAGIC_OFFSET + mobiHeaderLength > record.end
  ) {
    return damagedRecords();
  }

  const compression = readUint16(bytes, record.start);
  if (compression !== 1 && compression !== 2 && compression !== 17480) {
    throw new Error("此 Kindle 文件使用了不支持的压缩方式");
  }
  const encryption = readUint16(
    bytes,
    record.start + PALMDOC_ENCRYPTION_OFFSET
  );
  if (encryption !== 0) {
    throw new Error("此 Kindle 文件带有 DRM 或加密，当前无法导入");
  }

  const declaredTextLength = readUint32(
    bytes,
    record.start + PALMDOC_TEXT_LENGTH_OFFSET
  );
  if (declaredTextLength > MAX_KINDLE_TEXT_BYTES) {
    throw new Error("Kindle 正文解压后超过 2400 万字节，已停止导入");
  }
  const numTextRecords = readUint16(
    bytes,
    record.start + PALMDOC_TEXT_RECORD_COUNT_OFFSET
  );
  const recordSize = readUint16(
    bytes,
    record.start + PALMDOC_RECORD_SIZE_OFFSET
  );
  if (
    numTextRecords === 0 ||
    numTextRecords > MAX_TEXT_RECORDS ||
    recordSize === 0 ||
    recordIndex + numTextRecords >= records.length ||
    declaredTextLength > numTextRecords * recordSize
  ) {
    return damagedRecords();
  }

  const exthFlags = readUint32(bytes, record.start + MOBI_EXTH_FLAGS_OFFSET);
  const version = readUint32(bytes, record.start + MOBI_VERSION_OFFSET);
  const parsedBoundary = parseExthBoundary(
    bytes,
    record,
    mobiHeaderLength,
    exthFlags
  );
  const boundary = allowBoundary ? parsedBoundary : undefined;
  if (boundary !== undefined && (version >= 8 || boundary >= records.length)) {
    return damagedRecords();
  }

  return {
    envelope: {
      compression,
      declaredTextLength,
      numTextRecords,
      recordSize,
      trailingFlags: readUint32(
        bytes,
        record.start + MOBI_TRAILING_FLAGS_OFFSET
      ),
      huffRecord: readUint32(bytes, record.start + MOBI_HUFF_RECORD_OFFSET),
      numHuffRecords: readUint32(
        bytes,
        record.start + MOBI_HUFF_RECORD_COUNT_OFFSET
      ),
    },
    boundary,
  };
}

function variableLengthFromEnd(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes.subarray(-4)) {
    if ((byte & 0x80) !== 0) value = 0;
    value = value * 128 + (byte & 0x7f);
  }
  return value;
}

function withoutTrailingEntries(
  bytes: Uint8Array,
  trailingFlags: number
): Uint8Array {
  let result = bytes;
  let extraFlags = trailingFlags >>> 1;
  while (extraFlags !== 0) {
    if ((extraFlags & 1) !== 0) {
      const length = variableLengthFromEnd(result);
      if (length <= 0 || length > result.byteLength) return damagedText();
      result = result.subarray(0, result.byteLength - length);
    }
    extraFlags >>>= 1;
  }
  if ((trailingFlags & 1) !== 0) {
    if (result.byteLength === 0) return damagedText();
    const length = (result[result.byteLength - 1] & 3) + 1;
    if (length > result.byteLength) return damagedText();
    result = result.subarray(0, result.byteLength - length);
  }
  return result;
}

function palmDocDecodedLength(bytes: Uint8Array, limit: number): number {
  let outputLength = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0 || (byte >= 9 && byte <= 127)) {
      outputLength += 1;
    } else if (byte <= 8) {
      if (index + byte >= bytes.byteLength) return damagedText();
      outputLength += byte;
      index += byte;
    } else if (byte <= 191) {
      if (index + 1 >= bytes.byteLength) return damagedText();
      const pair = byte * 256 + bytes[index + 1];
      const distance = (pair & 0x3fff) >>> 3;
      if (distance === 0 || distance > outputLength) return damagedText();
      outputLength += (pair & 7) + 3;
      index += 1;
    } else {
      outputLength += 2;
    }
    if (outputLength > limit) {
      throw new Error("Kindle 正文解压后超过 2400 万字节，已停止导入");
    }
  }
  return outputLength;
}

function read32Bits(bytes: Uint8Array, bitOffset: number): number {
  const byteOffset = bitOffset >>> 3;
  const shift = bitOffset & 7;
  const first =
    ((bytes[byteOffset] ?? 0) * 0x1000000 +
      (bytes[byteOffset + 1] ?? 0) * 0x10000 +
      (bytes[byteOffset + 2] ?? 0) * 0x100 +
      (bytes[byteOffset + 3] ?? 0)) >>>
    0;
  if (shift === 0) return first;
  return (
    ((first << shift) | ((bytes[byteOffset + 4] ?? 0) >>> (8 - shift))) >>> 0
  );
}

function prefix(bits: number, length: number): number {
  return length === 32 ? bits >>> 0 : bits >>> (32 - length);
}

function createHuffLengthDecoder(
  bytes: Uint8Array,
  records: PalmRecord[],
  bookRecordIndex: number,
  envelope: BookEnvelope
): HuffLengthDecoder {
  if (
    envelope.numHuffRecords < 2 ||
    envelope.numHuffRecords > records.length ||
    envelope.huffRecord >= records.length ||
    bookRecordIndex + envelope.huffRecord + envelope.numHuffRecords >
      records.length
  ) {
    return damagedRecords();
  }

  const loadRecord = (relativeIndex: number): Uint8Array => {
    const record = records[bookRecordIndex + relativeIndex];
    if (!record) return damagedRecords();
    return bytes.subarray(record.start, record.end);
  };
  const huff = loadRecord(envelope.huffRecord);
  if (huff.byteLength < 16 || ascii(huff, 0, 4) !== "HUFF") {
    return damagedText();
  }
  const table1Offset = readUint32(huff, 8);
  const table2Offset = readUint32(huff, 12);
  if (
    table1Offset + 256 * 4 > huff.byteLength ||
    table2Offset + 32 * 8 > huff.byteLength
  ) {
    return damagedText();
  }

  const table1: HuffTableEntry[] = [];
  for (let index = 0; index < 256; index += 1) {
    const value = readUint32(huff, table1Offset + index * 4);
    table1.push({
      found: (value & 0x80) !== 0,
      codeLength: value & 0x1f,
      value: value >>> 8,
    });
  }
  const table2: [number, number][] = [[0, 0]];
  for (let index = 0; index < 32; index += 1) {
    table2.push([
      readUint32(huff, table2Offset + index * 8),
      readUint32(huff, table2Offset + index * 8 + 4),
    ]);
  }

  const dictionary: HuffDictionaryEntry[] = [];
  for (
    let recordOffset = 1;
    recordOffset < envelope.numHuffRecords;
    recordOffset += 1
  ) {
    const cdic = loadRecord(envelope.huffRecord + recordOffset);
    if (cdic.byteLength < 16 || ascii(cdic, 0, 4) !== "CDIC") {
      return damagedText();
    }
    const headerLength = readUint32(cdic, 4);
    const numEntries = readUint32(cdic, 8);
    const codeLength = readUint32(cdic, 12);
    if (
      headerLength < 16 ||
      headerLength > cdic.byteLength ||
      codeLength === 0 ||
      codeLength > 16 ||
      numEntries < dictionary.length ||
      numEntries > MAX_HUFF_DICTIONARY_ENTRIES
    ) {
      return damagedText();
    }

    const data = cdic.subarray(headerLength);
    const count = Math.min(2 ** codeLength, numEntries - dictionary.length);
    if (count * 2 > data.byteLength) return damagedText();
    for (let index = 0; index < count; index += 1) {
      const offset = readUint16(data, index * 2);
      if (offset < count * 2 || offset + 2 > data.byteLength) {
        return damagedText();
      }
      const header = readUint16(data, offset);
      const length = header & 0x7fff;
      if (length === 0 || offset + 2 + length > data.byteLength) {
        return damagedText();
      }
      dictionary.push({
        data: data.subarray(offset + 2, offset + 2 + length),
        decodedLength: (header & 0x8000) !== 0 ? length : undefined,
      });
    }
  }
  if (dictionary.length === 0) return damagedText();

  let codewords = 0;
  const decodeLength = (input: Uint8Array, depth = 0): number => {
    if (depth > MAX_HUFF_RECURSION_DEPTH) {
      throw new Error("Kindle 压缩数据过于复杂，已停止导入");
    }
    let outputLength = 0;
    const bitLength = input.byteLength * 8;
    for (let bitOffset = 0; bitOffset < bitLength;) {
      if (++codewords > MAX_HUFF_CODEWORDS) {
        throw new Error("Kindle 压缩数据过于复杂，已停止导入");
      }
      const bits = read32Bits(input, bitOffset);
      const first = table1[bits >>> 24];
      let codeLength = first.codeLength;
      let value = first.value;
      if (!first.found) {
        if (codeLength === 0) return damagedText();
        while (
          codeLength <= 32 &&
          prefix(bits, codeLength) < table2[codeLength][0]
        ) {
          codeLength += 1;
        }
        if (codeLength > 32) return damagedText();
        value = table2[codeLength][1];
      }
      if (codeLength === 0 || codeLength > 32) return damagedText();
      bitOffset += codeLength;
      if (bitOffset > bitLength) break;

      const code = value - prefix(bits, codeLength);
      const entry = dictionary[code];
      if (!entry) return damagedText();
      if (entry.decodedLength === undefined) {
        if (entry.visiting) return damagedText();
        entry.visiting = true;
        entry.decodedLength = decodeLength(entry.data, depth + 1);
        entry.visiting = false;
      }
      outputLength += entry.decodedLength;
      if (outputLength > MAX_KINDLE_TEXT_BYTES) {
        throw new Error("Kindle 正文解压后超过 2400 万字节，已停止导入");
      }
    }
    return outputLength;
  };

  return { decodedLength: decodeLength };
}

function validateTextRecords(
  bytes: Uint8Array,
  records: PalmRecord[],
  bookRecordIndex: number,
  envelope: BookEnvelope
): void {
  const huff =
    envelope.compression === 17480
      ? createHuffLengthDecoder(bytes, records, bookRecordIndex, envelope)
      : undefined;
  let totalLength = 0;

  for (let index = 0; index < envelope.numTextRecords; index += 1) {
    const record = records[bookRecordIndex + index + 1];
    if (!record) return damagedRecords();
    const content = withoutTrailingEntries(
      bytes.subarray(record.start, record.end),
      envelope.trailingFlags
    );
    let decodedLength: number;
    if (envelope.compression === 1) {
      decodedLength = content.byteLength;
    } else if (envelope.compression === 2) {
      decodedLength = palmDocDecodedLength(content, MAX_KINDLE_TEXT_BYTES);
    } else {
      decodedLength = huff!.decodedLength(content);
    }
    if (decodedLength > envelope.recordSize) return damagedText();
    totalLength += decodedLength;
    if (totalLength > MAX_KINDLE_TEXT_BYTES) {
      throw new Error("Kindle 正文解压后超过 2400 万字节，已停止导入");
    }
  }
}

/**
 * Validate all size-bearing PalmDB/MOBI fields and dry-run decompression before
 * the third-party parser allocates or concatenates untrusted text records.
 */
export function validateMobiBytes(bytes: Uint8Array): void {
  if (bytes.byteLength < 96) return invalidEnvelope();
  if (bytes.byteLength > MAX_KINDLE_BYTES)
    throw new Error("Kindle 文件不能超过 128 MB");
  if (ascii(bytes, PALM_DATABASE_SIGNATURE_OFFSET, 8) !== "BOOKMOBI") {
    return invalidEnvelope();
  }

  const records = parsePalmRecords(bytes);
  const primary = parseBookEnvelope(bytes, records, 0, true);
  const selected =
    primary.boundary === undefined
      ? { ...primary, recordIndex: 0 }
      : {
          ...parseBookEnvelope(bytes, records, primary.boundary, false),
          recordIndex: primary.boundary,
        };
  validateTextRecords(bytes, records, selected.recordIndex, selected.envelope);
}

function fileTitle(file: File): string {
  return file.name.replace(/\.(?:azw3?|mobi)$/i, "");
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 180)
    : "未知解析错误";
}

async function initializeKindleParser(
  bytes: Uint8Array,
  format: KindleFormat
): Promise<
  HtmlBookParser & {
    destroy(): void;
    getMetadata(): { title: string; author: string[] };
    getCoverImage(): string;
  }
> {
  if (format === "azw3") return initKf8File(bytes);

  let kf8Parser: Awaited<ReturnType<typeof initKf8File>> | undefined;
  try {
    kf8Parser = await initKf8File(bytes);
    if (kf8Parser.getSpine().length > 0) return kf8Parser;
  } catch {
    // Legacy MOBI files do not contain KF8 records; retry with the MOBI parser.
  }
  kf8Parser?.destroy();
  return initMobiFile(bytes);
}

export async function parseMobi(
  file: File,
  format: KindleFormat,
  onProgress?: (stage: string, ratio: number) => void
): Promise<ParsedBook> {
  if (file.size > MAX_KINDLE_BYTES)
    throw new Error("Kindle 文件不能超过 128 MB");

  onProgress?.("校验 Kindle 文件", 0.03);
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateMobiBytes(bytes);

  let parser: Awaited<ReturnType<typeof initializeKindleParser>> | undefined;
  try {
    onProgress?.("读取 Kindle 书目信息", 0.1);
    parser = await initializeKindleParser(bytes, format);
    const metadata = parser.getMetadata();
    const title = metadata.title?.trim() || fileTitle(file);
    const author = (metadata.author ?? [])
      .map(item => item.trim())
      .filter(Boolean)
      .join("、");

    let cover: string | undefined;
    try {
      cover = await coverResourceToDataUrl(parser.getCoverImage());
    } catch {
      // A broken optional cover must not prevent importing readable text.
    }
    const chapters = extractHtmlBookChapters(parser, (completed, total) => {
      onProgress?.(
        "解析 Kindle 章节",
        0.18 + 0.78 * (completed / Math.max(total, 1))
      );
    });
    if (chapters.length === 0)
      throw new Error("未能从 Kindle 文件中识别出正文");

    onProgress?.("完成导入", 1);
    return { title, author, cover, chapters };
  } catch (error) {
    if (
      error instanceof Error &&
      /(?:不能超过|已停止导入|无法导入|未能从)/.test(error.message)
    ) {
      throw error;
    }
    throw new Error(
      `未能解析 ${format.toUpperCase()} 文件：${errorDetail(error)}`,
      {
        cause: error,
      }
    );
  } finally {
    parser?.destroy();
  }
}
