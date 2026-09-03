import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  EPUB_LIMITS,
  parseEpub,
  validateEpubArchive,
  validateEpubEntryLimits,
  validateEpubFileSize,
} from "./parseEpub";

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

async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
}

describe("EPUB resource limits", () => {
  it("允许结构和大小正常的 EPUB 压缩包", async () => {
    const bytes = await makeZip({
      mimetype: "application/epub+zip",
      "META-INF/container.xml":
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      "OEBPS/content.opf":
        '<package><metadata><dc:title>Test</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      "OEBPS/c1.xhtml":
        "<html><body><h1>Chapter 1</h1><p>Hello.</p></body></html>",
    });
    const zip = await JSZip.loadAsync(bytes);

    expect(() => validateEpubFileSize(bytes.byteLength)).not.toThrow();
    expect(() => validateEpubArchive(zip)).not.toThrow();
  });

  it("在读取前拒绝超限的 EPUB 原文件", async () => {
    let read = false;
    const file = {
      name: "large.epub",
      size: EPUB_LIMITS.fileBytes + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as File;

    await expect(parseEpub(file)).rejects.toThrow("超过 128 MB");
    expect(read).toBe(false);
  });

  it("拒绝过多条目、过大单条目和过大累计声明", () => {
    expect(() =>
      validateEpubEntryLimits(
        Array.from({ length: EPUB_LIMITS.entries + 1 }, (_, index) => ({
          name: `${index}.xhtml`,
          uncompressedSize: 1,
        }))
      )
    ).toThrow("条目超过");

    expect(() =>
      validateEpubEntryLimits([
        {
          name: "huge.xhtml",
          uncompressedSize: EPUB_LIMITS.entryBytes + 1,
        },
      ])
    ).toThrow("单个条目");

    expect(() =>
      validateEpubEntryLimits([
        { name: "a.bin", uncompressedSize: EPUB_LIMITS.entryBytes },
        { name: "b.bin", uncompressedSize: EPUB_LIMITS.entryBytes },
        { name: "c.bin", uncompressedSize: EPUB_LIMITS.entryBytes },
        { name: "d.bin", uncompressedSize: EPUB_LIMITS.entryBytes },
        { name: "extra.bin", uncompressedSize: 1 },
      ])
    ).toThrow("解压总量超过");
  });

  it("在 DOM 解析前拒绝解压后过大的 container.xml", async () => {
    const bytes = await makeZip({
      "META-INF/container.xml": "x".repeat(EPUB_LIMITS.containerBytes + 1),
    });

    await expect(parseEpub(fakeFile("bomb.epub", bytes))).rejects.toThrow(
      "container.xml解压后内容过大"
    );
  });
});
