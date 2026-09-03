import { detect } from "chardet";

import type { Chapter } from "@/types";
import { uid } from "./db";
import type { ParsedBook } from "./parseBook";
import {
  joinBrokenLines,
  looksLikeHeading,
  normalizeParagraph,
} from "./reflow";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 12_000_000;
const MAX_CHAPTERS = 5_000;
const MAX_PARAGRAPHS = 250_000;
const DETECTION_SAMPLE_BYTES = 1024 * 1024;

const TITLE_HEADER = /^(?:书名|書名|标题|標題|title)\s*[:：]\s*(.+)$/i;
const AUTHOR_HEADER = /^(?:作者|著者|编者|author|by)\s*[:：]\s*(.+)$/i;
const BOOK_TITLE = /^《(.{1,120})》$/;
const AUTHOR_BYLINE = /^(.{1,100}?)\s*(?:著|编著|编|译)$/;
const ENGLISH_BYLINE = /^by\s+(.{1,100})$/i;
const SENTENCE_END = /[。！？…；：」』”’）】.!?;:]$/;
const INDENTED = /^[\t \u3000]{2,}/;
const COMMON_HAN = new Set(
  "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题程展五果料象员位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指区强放决西被做必战先回则任取据处理世车门书書名标標作者著章节正文编編码碼测測试試简簡体體内容點這繁"
);
const EBOOK_STRUCTURE =
  /(?:书名|書名|标题|標題|作者|著者|第[〇○一二三四五六七八九十百千零0-9０-９]{1,8}[章节卷部篇回集]|序章|正文|chapter\s+[\divxlcdm]+)/giu;

interface DecodedText {
  text: string;
  encoding: string;
}

function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): string {
  if (bytes.byteLength % 4 !== 0) {
    throw new Error("TXT 的 UTF-32 字节长度无效");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codePoints: number[] = [];
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const codePoint = view.getUint32(offset, littleEndian);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error("TXT 包含无效的 UTF-32 字符");
    }
    codePoints.push(codePoint);
    if (codePoints.length === 4_096) {
      output += String.fromCodePoint(...codePoints);
      codePoints.length = 0;
    }
  }
  return output + String.fromCodePoint(...codePoints);
}

function decoderLabel(name: string | null): string | null {
  if (!name) return null;
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    ascii: "windows-1252",
    big5: "big5",
    eucjp: "euc-jp",
    euckr: "euc-kr",
    gb18030: "gb18030",
    gb2312: "gb18030",
    gbk: "gb18030",
    iso2022jp: "iso-2022-jp",
    iso88591: "windows-1252",
    koi8r: "koi8-r",
    shiftjis: "shift_jis",
    sjis: "shift_jis",
    tis620: "windows-874",
    utf8: "utf-8",
    utf16be: "utf-16be",
    utf16le: "utf-16le",
  };
  if (aliases[compact]) return aliases[compact];

  const windows = compact.match(/^windows(125[0-8]|874)$/);
  return windows ? `windows-${windows[1]}` : null;
}

interface LegacyCandidate {
  encoding: string;
  score: number;
}

function isPrivateUse(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

/**
 * Give every successfully decoded candidate a comparable, explainable score.
 * Structural ebook words and common Han characters are positive evidence;
 * replacement/control/private-use characters and dense Latin-1 mojibake are
 * negative evidence. Chardet is only a small tie-breaking hint, not a verdict.
 */
function scoreLegacyText(
  text: string,
  encoding: string,
  detected: string | null
): number {
  let score = encoding === detected ? 8 : 0;
  let visible = 0;
  let commonHan = 0;
  let extendedLatin = 0;

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!/\s/u.test(character)) visible++;
    if (COMMON_HAN.has(character)) commonHan++;
    if (codePoint >= 0x80 && codePoint <= 0x024f) extendedLatin++;

    if (character === "\ufffd") score -= 1_000;
    if (isSuspiciousControl(codePoint)) score -= 500;
    if (isPrivateUse(codePoint)) score -= 120;
    // Wrong Big5/GB18030 decoding often leaks Bopomofo into ordinary prose.
    if (codePoint >= 0x3100 && codePoint <= 0x312f) score -= 12;
  }

  score += commonHan * 2;
  score += (text.match(EBOOK_STRUCTURE)?.length ?? 0) * 18;
  score += (text.match(/[，。！？：；「」『』“”《》]/gu)?.length ?? 0) * 2;

  // Chinese bytes decoded as Windows-1252 become a dense wall of accented
  // Latin characters. A normal Western-language book rarely crosses 35%.
  if (visible > 0 && extendedLatin / visible > 0.35) {
    score -= extendedLatin * 4;
  }
  return score;
}

function decodeLegacy(bytes: Uint8Array): DecodedText {
  const sample = bytes.subarray(0, DETECTION_SAMPLE_BYTES);
  const detected = decoderLabel(detect(sample));
  const candidates = Array.from(
    new Set([detected, "gb18030", "big5", "windows-1252"].filter(Boolean))
  ) as string[];

  const decodedCandidates: LegacyCandidate[] = [];
  for (const encoding of candidates) {
    try {
      // A sample may end in the middle of a multi-byte character. Streaming
      // mode buffers that final fragment rather than rejecting the encoding.
      const text = new TextDecoder(encoding, { fatal: true }).decode(sample, {
        stream: sample.byteLength < bytes.byteLength,
      });
      decodedCandidates.push({
        encoding,
        score: scoreLegacyText(text, encoding, detected),
      });
    } catch {
      // Unsupported or invalid candidates are tried in turn.
    }
  }

  decodedCandidates.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.encoding === detected) - Number(a.encoding === detected) ||
      a.encoding.localeCompare(b.encoding)
  );

  // Decode the complete payload one candidate at a time. This avoids retaining
  // several full-text strings merely to select an encoding for a large book.
  for (const candidate of decodedCandidates) {
    try {
      return {
        text: new TextDecoder(candidate.encoding, { fatal: true }).decode(
          bytes
        ),
        encoding: candidate.encoding,
      };
    } catch {
      // Bytes beyond the sample can still invalidate a candidate.
    }
  }
  throw new Error("无法识别 TXT 文件编码，请将文件转换为 UTF-8 后重试");
}

/** Decode a TXT payload without silently replacing malformed input. */
export function decodeTxtBytes(bytes: Uint8Array): DecodedText {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) {
    return {
      text: decodeUtf32(bytes.subarray(4), false),
      encoding: "utf-32be",
    };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return { text: decodeUtf32(bytes.subarray(4), true), encoding: "utf-32le" };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)),
      encoding: "utf-8",
    };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder("utf-16le", { fatal: true }).decode(
        bytes.subarray(2)
      ),
      encoding: "utf-16le",
    };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder("utf-16be", { fatal: true }).decode(
        bytes.subarray(2)
      ),
      encoding: "utf-16be",
    };
  }

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
    };
  } catch {
    return decodeLegacy(bytes);
  }
}

function isChapterHeading(line: string): boolean {
  const text = line.trim();
  return (
    looksLikeHeading(text) ||
    /^(?:book|section)\s+[\divxlcdm]+(?:\s*(?:-|:|—).{1,28}|\s+.{1,28})?$/i.test(
      text
    ) ||
    /^(?:卷|篇|部)\s*[〇○一二三四五六七八九十百千零0-9０-９]{1,8}(?:\s+.{1,24})?$/.test(
      text
    )
  );
}

function isSuspiciousControl(code: number): boolean {
  return code < 9 || code === 11 || code === 12 || (code >= 14 && code <= 31);
}

function cleanLine(line: string): string {
  let cleaned = "";
  for (const character of line) {
    const code = character.charCodeAt(0);
    if (!isSuspiciousControl(code) && code !== 127) cleaned += character;
  }
  return cleaned;
}

function shouldStartParagraph(previous: string, nextRaw: string): boolean {
  if (INDENTED.test(nextRaw)) return true;
  if (SENTENCE_END.test(previous)) return true;
  return previous.length > 120 || nextRaw.trim().length > 120;
}

function extractMetadata(lines: string[], fallbackTitle: string) {
  let title = fallbackTitle;
  let author = "";
  const remove = new Set<number>();
  const candidateIndexes: number[] = [];

  for (
    let i = 0;
    i < lines.length && i < 200 && candidateIndexes.length < 80;
    i++
  ) {
    const text = lines[i].trim();
    if (!text) continue;
    candidateIndexes.push(i);
  }

  for (const index of candidateIndexes) {
    const text = lines[index].trim();
    const titleMatch = text.match(TITLE_HEADER);
    if (titleMatch?.[1] && title === fallbackTitle) {
      title = titleMatch[1].trim().slice(0, 200);
      remove.add(index);
      continue;
    }
    const authorMatch = text.match(AUTHOR_HEADER);
    if (authorMatch?.[1] && !author) {
      author = authorMatch[1].trim().slice(0, 200);
      remove.add(index);
    }
  }

  const first = candidateIndexes[0];
  if (first !== undefined && title === fallbackTitle) {
    const match = lines[first].trim().match(BOOK_TITLE);
    if (match?.[1]) {
      title = match[1].trim();
      remove.add(first);
    }
  }

  const possibleByline = candidateIndexes.find(index => {
    const text = lines[index].trim();
    return AUTHOR_BYLINE.test(text) || ENGLISH_BYLINE.test(text);
  });
  if (possibleByline !== undefined && !author) {
    const text = lines[possibleByline].trim();
    const byline =
      text.match(AUTHOR_BYLINE)?.[1] ?? text.match(ENGLISH_BYLINE)?.[1];
    if (byline) {
      author = byline.trim();
      remove.add(possibleByline);
    }
  }

  if (possibleByline !== undefined && title === fallbackTitle) {
    const bylinePosition = candidateIndexes.indexOf(possibleByline);
    for (let i = bylinePosition - 1; i >= 0; i--) {
      const candidate = lines[candidateIndexes[i]].trim();
      if (
        candidate &&
        candidate.length <= 200 &&
        !/^\[.*\]$/.test(candidate) &&
        !/^\*{3}/.test(candidate) &&
        !/^the project gutenberg ebook/i.test(candidate)
      ) {
        title = candidate;
        remove.add(candidateIndexes[i]);
        break;
      }
    }
  }

  return {
    title: title || fallbackTitle,
    author,
    lines: lines.filter((_, index) => !remove.has(index)),
  };
}

function createChapters(lines: string[]): Chapter[] {
  const chapters: Chapter[] = [];
  let title = "正文";
  let paragraphs: string[] = [];
  let paragraph = "";

  const finishParagraph = () => {
    const normalized = normalizeParagraph(paragraph);
    paragraph = "";
    if (!normalized) return;
    paragraphs.push(normalized);
    if (paragraphs.length > MAX_PARAGRAPHS) {
      throw new Error("TXT 段落数量过多，请拆分文件后重试");
    }
  };

  const finishChapter = () => {
    finishParagraph();
    if (paragraphs.length === 0) return;
    chapters.push({ id: uid(), title, paragraphs });
    paragraphs = [];
    if (chapters.length > MAX_CHAPTERS) {
      throw new Error("TXT 章节数量过多，请拆分文件后重试");
    }
  };

  for (const rawLine of lines) {
    const text = rawLine.trim();
    if (!text) {
      finishParagraph();
      continue;
    }
    if (isChapterHeading(text)) {
      finishChapter();
      title = text;
      continue;
    }
    if (!paragraph) {
      paragraph = text;
    } else if (shouldStartParagraph(paragraph, rawLine)) {
      finishParagraph();
      paragraph = text;
    } else {
      paragraph = joinBrokenLines(paragraph, text);
    }
  }
  finishChapter();
  return chapters;
}

export async function parseTxt(
  file: File,
  onProgress?: (stage: string, ratio: number) => void
): Promise<ParsedBook> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("TXT 文件超过 64 MB，请拆分后再导入");
  }

  onProgress?.("读取 TXT", 0.05);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("TXT 文件超过 64 MB，请拆分后再导入");
  }
  if (bytes.byteLength === 0) throw new Error("TXT 文件为空");

  onProgress?.("识别文本编码", 0.2);
  let decoded: DecodedText;
  try {
    decoded = decodeTxtBytes(bytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("TXT")) throw error;
    throw new Error(
      `TXT 解码失败：${error instanceof Error ? error.message : "未知错误"}`
    );
  }

  if (decoded.text.length > MAX_TEXT_CHARACTERS) {
    throw new Error("TXT 解码后超过 1200 万字符，请拆分后再导入");
  }

  const cleaned = decoded.text
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanLine);
  const totalChars = Math.max(1, decoded.text.length);
  let suspiciousChars = 0;
  for (let i = 0; i < decoded.text.length; i++) {
    if (isSuspiciousControl(decoded.text.charCodeAt(i))) suspiciousChars++;
  }
  if (suspiciousChars / totalChars > 0.01) {
    throw new Error("TXT 文件似乎包含二进制数据，无法作为纯文本导入");
  }

  const fallbackTitle = file.name.replace(/\.txt$/i, "").trim() || "未命名书籍";
  const metadata = extractMetadata(cleaned, fallbackTitle);

  onProgress?.("分析章节", 0.55);
  const chapters = createChapters(metadata.lines);
  if (chapters.length === 0) {
    throw new Error("TXT 中未识别到可阅读的正文");
  }

  onProgress?.("完成导入", 1);
  return {
    title: metadata.title,
    author: metadata.author,
    chapters,
  };
}
