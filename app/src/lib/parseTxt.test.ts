import { describe, expect, it } from "vitest";

import { decodeTxtBytes, MAX_TEXT_CHARACTERS, parseTxt } from "./parseTxt";

function fakeFile(name: string, bytes: Uint8Array, size = bytes.byteLength) {
  return {
    name,
    size,
    arrayBuffer: async () =>
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
  } as File;
}

function utf16LeBom(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  }
  return bytes;
}

function utf16WithoutBom(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(i * 2, text.charCodeAt(i), littleEndian);
  }
  return bytes;
}

// Fixed bytes generated from the source text with the named legacy encoding.
// Keeping them inline ensures decoding tests do not depend on another codec.
const GB18030_BOOK = new Uint8Array([
  202, 233, 195, 251, 163, 186, 177, 224, 194, 235, 178, 226, 202, 212, 10, 215,
  247, 213, 223, 163, 186, 213, 197, 200, 253, 10, 10, 181, 218, 210, 187, 213,
  194, 32, 198, 240, 181, 227, 10, 213, 226, 202, 199, 188, 242, 204, 229, 214,
  208, 206, 196, 196, 218, 200, 221, 161, 163,
]);
const BIG5_BOOK = new Uint8Array([
  174, 209, 166, 87, 161, 71, 189, 115, 189, 88, 180, 250, 184, 213, 10, 167,
  64, 170, 204, 161, 71, 177, 105, 164, 84, 10, 10, 178, 196, 164, 64, 179, 185,
  32, 176, 95, 194, 73, 10, 179, 111, 172, 79, 193, 99, 197, 233, 164, 164, 164,
  229, 164, 186, 174, 101, 161, 67,
]);
const SHORT_GB18030 = new Uint8Array([
  213, 226, 202, 199, 188, 242, 204, 229, 214, 208, 206, 196, 196, 218, 200,
  221, 161, 163,
]);
const SHORT_BIG5 = new Uint8Array([
  179, 111, 172, 79, 193, 99, 197, 233, 164, 164, 164, 229, 164, 186, 174, 101,
  161, 67,
]);

describe("parseTxt", () => {
  it("keeps the decoded-text budget above the supported 64 MiB file size", () => {
    expect(MAX_TEXT_CHARACTERS).toBeGreaterThan(64 * 1024 * 1024);
  });

  it("提取元数据并按标题切分章节", async () => {
    const text = [
      "书名：测试小说",
      "作者：张三",
      "",
      "第一章 起点",
      "第一段。",
      "第二段。",
      "",
      "第二章 继续",
      "后续内容。",
    ].join("\n");

    const parsed = await parseTxt(
      fakeFile("原文.txt", new TextEncoder().encode(text))
    );

    expect(parsed.title).toBe("测试小说");
    expect(parsed.author).toBe("张三");
    expect(parsed.chapters.map(chapter => chapter.title)).toEqual([
      "第一章 起点",
      "第二章 继续",
    ]);
    expect(parsed.chapters[0].paragraphs).toEqual(["第一段。", "第二段。"]);
  });

  it("支持 UTF-16LE BOM", async () => {
    const bytes = utf16LeBom("《编码之书》\n李四 著\n\n序章\n正文内容。");
    expect(decodeTxtBytes(bytes).encoding).toBe("utf-16le");

    const parsed = await parseTxt(fakeFile("fallback.txt", bytes));
    expect(parsed.title).toBe("编码之书");
    expect(parsed.author).toBe("李四");
    expect(parsed.chapters[0]).toMatchObject({
      title: "序章",
      paragraphs: ["正文内容。"],
    });
  });

  it.each([
    ["utf-16le", true],
    ["utf-16be", false],
  ] as const)("支持无 BOM 的 %s", async (encoding, littleEndian) => {
    const bytes = utf16WithoutBom(
      "书名：无 BOM 编码\n作者：王五\n\n第一章\n正文内容。",
      littleEndian
    );

    expect(decodeTxtBytes(bytes)).toMatchObject({
      encoding,
      text: expect.stringContaining("无 BOM 编码"),
    });
    const parsed = await parseTxt(fakeFile(`${encoding}.txt`, bytes));
    expect(parsed).toMatchObject({ title: "无 BOM 编码", author: "王五" });
    expect(parsed.chapters[0].paragraphs).toEqual(["正文内容。"]);
  });

  it.each([
    ["utf-16le", true],
    ["utf-16be", false],
  ] as const)("可从纯 CJK 单行识别无 BOM 的 %s", (encoding, littleEndian) => {
    const bytes = utf16WithoutBom(
      "书名：编码测试作者：张三第一章正文内容。",
      littleEndian
    );
    expect(decodeTxtBytes(bytes)).toMatchObject({ encoding });
  });

  it("正确识别并解码 GB18030 真实字节", async () => {
    const decoded = decodeTxtBytes(GB18030_BOOK);
    expect(decoded).toMatchObject({
      encoding: "gb18030",
      text: expect.stringContaining("这是简体中文内容。"),
    });

    const parsed = await parseTxt(fakeFile("gb.txt", GB18030_BOOK));
    expect(parsed).toMatchObject({ title: "编码测试", author: "张三" });
    expect(parsed.chapters[0].title).toBe("第一章 起点");
  });

  it("正确识别并解码 Big5 真实字节", async () => {
    const decoded = decodeTxtBytes(BIG5_BOOK);
    expect(decoded).toMatchObject({
      encoding: "big5",
      text: expect.stringContaining("這是繁體中文內容。"),
    });

    const parsed = await parseTxt(fakeFile("big5.txt", BIG5_BOOK));
    expect(parsed).toMatchObject({ title: "編碼測試", author: "張三" });
    expect(parsed.chapters[0].title).toBe("第一章 起點");
  });

  it("候选评分可以纠正短文本的编码检测偏差", () => {
    expect(decodeTxtBytes(SHORT_GB18030)).toEqual({
      encoding: "gb18030",
      text: "这是简体中文内容。",
    });
    expect(decodeTxtBytes(SHORT_BIG5)).toEqual({
      encoding: "big5",
      text: "這是繁體中文內容。",
    });
  });

  it("识别无冒号的英文书名与 by 作者行", async () => {
    const text = [
      "*** START OF THE PROJECT GUTENBERG EBOOK 11 ***",
      "",
      "[Illustration]",
      "",
      "Alice's Adventures in Wonderland",
      "",
      "by Lewis Carroll",
      "",
      "CHAPTER I.",
      "Down the Rabbit-Hole",
      "",
      "Alice was beginning to get very tired.",
    ].join("\n");

    const parsed = await parseTxt(
      fakeFile("alice.txt", new TextEncoder().encode(text))
    );
    expect(parsed.title).toBe("Alice's Adventures in Wonderland");
    expect(parsed.author).toBe("Lewis Carroll");
  });

  it("拒绝空文件和超限文件", async () => {
    await expect(
      parseTxt(fakeFile("empty.txt", new Uint8Array()))
    ).rejects.toThrow("文件为空");
    await expect(
      parseTxt(fakeFile("large.txt", new Uint8Array([65]), 65 * 1024 * 1024))
    ).rejects.toThrow("超过 64 MB");
  });
});
