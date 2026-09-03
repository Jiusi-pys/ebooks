/**
 * 文字重排：把按行硬断开的原文重新组织成自然段落。
 * - CJK 行尾直接拼接，拉丁行尾以空格拼接、处理断词连字符
 * - 依据行间距、缩进、句末标点推断段落边界
 */

const CJK = /[㐀-鿿豈-﫿＀-￯　-〿]$/;
const CJK_START = /^[㐀-鿿豈-﫿＀-￯　-〿]/;
const SENTENCE_END = /[。！？…：；」』”’）】\.!?]$/;

export interface RawLine {
  text: string;
  /** 行高（字号近似值） */
  height: number;
  /** 左边距 */
  x: number;
  /** 与上一行的垂直间距（已按阅读顺序换算为正值；首行给大值） */
  gapAbove: number;
}

export function joinBrokenLines(a: string, b: string): string {
  if (!a) return b;
  // 拉丁断词：行尾连字符直接去掉并拼接
  if (/-$/.test(a) && /^[a-zA-Z]/.test(b)) return a.slice(0, -1) + b;
  const needSpace = !CJK.test(a) && !CJK_START.test(b);
  return a + (needSpace ? ' ' : '') + b;
}

/** 把带几何信息的行折叠为段落 */
export function reflowLines(lines: RawLine[]): string[] {
  if (lines.length === 0) return [];
  const heights = lines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 12;
  const xs = lines.map((l) => l.x).sort((a, b) => a - b);
  const minX = xs[0] ?? 0;
  // 行距中位数：段落间距是相对“常规行距”判定的，而非字号
  const gaps = lines
    .slice(1)
    .map((l) => l.gapAbove)
    .filter((g) => g > 0 && g < medH * 10)
    .sort((a, b) => a - b);
  const medGap = gaps[Math.floor(gaps.length / 2)] || medH * 1.4;
  const paraGap = Math.max(medH * 1.6, medGap * 1.35);

  const paragraphs: string[] = [];
  let cur = '';
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (!cur) {
      cur = text;
      continue;
    }
    const bigGap = line.gapAbove > paraGap;
    const indented = line.x > minX + medH * 1.2 && SENTENCE_END.test(cur);
    if (bigGap || indented) {
      paragraphs.push(cur);
      cur = text;
    } else {
      cur = joinBrokenLines(cur, text);
    }
  }
  if (cur) paragraphs.push(cur);
  return paragraphs.map(normalizeParagraph).filter((p) => p.length > 0);
}

export function normalizeParagraph(p: string): string {
  let t = p.replace(/[ \t]+/g, ' ').trim();
  // 中英文之间补一个窄空隙感（用普通空格，排版端用 CSS 控制）
  t = t.replace(/([A-Za-z0-9])([㐀-鿿])/g, '$1 $2').replace(/([㐀-鿿])([A-Za-z0-9])/g, '$1 $2');
  return t;
}

const CHAPTER_RE =
  /^(第[〇一二三四五六七八九十百千零0-9０-９]{1,6}[章节卷部篇回集][^。！？]{0,26}|序章|序言|序|前言|引言|导言|楔子|尾声|后记|跋|附录|参考文献|chapter\s+[\divxl]+.{0,24}|part\s+[\divxl]+.{0,24})$/i;

export function looksLikeHeading(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 34) return false;
  return CHAPTER_RE.test(t);
}
