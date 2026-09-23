import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  EPUB_LIMITS,
  extractEpubPackageFields,
  parseEpub,
  validateEpubArchive,
  validateEpubEntryLimits,
  validateEpubFileSize,
} from "./parseEpub";

function fakeElement(
  textContent = "",
  attributes: Record<string, string> = {},
  descendants: Record<string, Element[]> = {}
): Element {
  return {
    textContent,
    getAttribute: (name: string) => attributes[name] ?? null,
    getAttributeNS: (_namespace: string | null, name: string) =>
      attributes[`opf:${name}`] ?? attributes[name] ?? null,
    getElementsByTagNameNS: (_namespace: string | null, name: string) =>
      descendants[name] ?? [],
    getElementsByTagName: (name: string) =>
      descendants[name.replace(/^dc:/, "")] ?? [],
  } as unknown as Element;
}

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

describe("extractEpubPackageFields", () => {
  it("extracts EPUB 3 Dublin Core metadata and contributor roles", () => {
    const mainTitle = fakeElement("The Main Title", { id: "main-title" });
    const subtitle = fakeElement("A Subtitle", { id: "subtitle" });
    const creators = [
      fakeElement("Alice"),
      fakeElement("Bob"),
      fakeElement("Eve", { id: "editor" }),
    ];
    const contributors = [fakeElement("Tracy", { "opf:role": "trl" })];
    const publicationDate = fakeElement("2024-02-29T00:00:00Z", {
      "opf:event": "publication",
    });
    const conversionDate = fakeElement("2025-01-01", {
      "opf:event": "conversion",
    });
    const isbn = fakeElement("urn:isbn:978-1-4028-9462-6", { id: "isbn" });
    const doi = fakeElement("10.1000/example", { id: "doi" });
    const metas = [
      fakeElement("main", {
        refines: "#main-title",
        property: "title-type",
      }),
      fakeElement("subtitle", {
        refines: "#subtitle",
        property: "title-type",
      }),
      fakeElement("DOI", {
        refines: "#doi",
        property: "identifier-type",
      }),
      fakeElement("edt", {
        refines: "#editor",
        property: "role",
      }),
    ];
    const metadata = fakeElement(
      "",
      {},
      {
        title: [mainTitle, subtitle],
        creator: creators,
        contributor: contributors,
        meta: metas,
        publisher: [fakeElement("Example Press")],
        date: [conversionDate, publicationDate],
        language: [fakeElement("en_US"), fakeElement("zh-Hans")],
        identifier: [isbn, doi],
        subject: [fakeElement("History"), fakeElement("Reference")],
        description: [fakeElement("An example description.")],
        rights: [fakeElement("Copyright holder")],
      }
    );
    const opf = fakeElement("", {}, { metadata: [metadata] });

    expect(
      extractEpubPackageFields(opf as unknown as Document, "fallback")
    ).toEqual({
      title: "The Main Title",
      author: "Alice、Bob",
      metadata: {
        version: 1,
        subtitle: "A Subtitle",
        contributors: [
          { name: "Alice", role: "author" },
          { name: "Bob", role: "author" },
          { name: "Eve", role: "editor" },
          { name: "Tracy", role: "translator" },
        ],
        publisher: "Example Press",
        publishedDate: "2024-02-29",
        languages: ["en-US", "zh-Hans"],
        identifiers: [
          { scheme: "ISBN", value: "978-1-4028-9462-6" },
          { scheme: "DOI", value: "10.1000/example" },
        ],
        subjects: ["History", "Reference"],
        description: "An example description.",
        rights: "Copyright holder",
      },
    });
  });
});
