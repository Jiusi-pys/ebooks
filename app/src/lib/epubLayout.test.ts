// @vitest-environment jsdom
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEpubContent } from "./epubContent";
import { parseEpub } from "./parseEpub";
import { inspectEpubImage, isEpubLayout, readEpubImage } from "./epubLayout";

const doc = (body: string) =>
  new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>test</title></head><body>${body}</body></html>`,
    "application/xhtml+xml"
  );
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII="
  ),
  c => c.charCodeAt(0)
);
async function book(
  body: string,
  options: { image?: Uint8Array; guide?: string; cover?: boolean } = {}
) {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
  );
  zip.file(
    "OPS/book.opf",
    `<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="im" href="img.png" media-type="image/png" ${options.cover ? 'properties="cover-image"' : ""}/></manifest><spine><itemref idref="a"/></spine>${options.guide ? `<guide><reference type="cover" href="${options.guide}"/></guide>` : ""}</package>`
  );
  zip.file("OPS/a.xhtml", new XMLSerializer().serializeToString(doc(body)));
  zip.file("OPS/img.png", options.image ?? png);
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  return {
    size: bytes.byteLength,
    name: "test.epub",
    arrayBuffer: async () => bytes,
  } as File;
}
afterEach(() => vi.unstubAllGlobals());

describe("EPUB local layout extraction", () => {
  it("retains standalone body image note markers without creating paragraphs", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            '<img src="i.png"/><sup><a epub:type="noteref" href="n.xhtml#n">[1]</a></sup><p>正文</p>'
          ),
        ],
        ["n.xhtml", doc('<aside id="n" epub:type="footnote">NOTE</aside>')],
      ]),
      ["a.xhtml"],
      []
    );
    expect(result.chapters[0].paragraphs).toEqual(["正文"]);
    expect(result.chapters[0].footnotes).toBeUndefined();
    expect(result.layout.chapters[result.chapters[0].id].items).toEqual([
      { kind: "image", assetId: "i.png", alt: "" },
      {
        kind: "text",
        text: "[1]",
        notes: [{ start: 0, end: 3, content: "NOTE" }],
        role: "image-note",
      },
      { kind: "paragraph", paraIndex: 0 },
    ]);
  });
  it("maps wrapped image IDs and wrapper IDs to the owning chapter top", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            '<figure id="figure"><span id="wrapper"><img id="plate" src="i.png"/></span><figcaption>CAPTION</figcaption></figure><p>正文</p>'
          ),
        ],
      ]),
      ["a.xhtml"],
      [
        { title: "Plate", target: "a.xhtml#plate", depth: 0 },
        { title: "Wrapper", target: "a.xhtml#wrapper", depth: 0 },
        { title: "Figure", target: "a.xhtml#figure", depth: 0 },
      ]
    );
    expect(result.chapters[0].paragraphs).toEqual(["正文"]);
    for (const target of result.outline) {
      expect(target.chapterId).toBe(result.chapters[0].id);
      expect(target.paraIndex).toBeUndefined();
    }
  });
  it("keeps old paragraphs, UTF-16 notes and figure order without duplicate captions", () => {
    const docs = new Map([
      [
        "OPS/a.xhtml",
        doc(
          '<p id="before">正文😀<a epub:type="noteref" href="notes.xhtml#n">[1]</a></p><figure><img src="img.png" alt="Original alt"/><p><a epub:type="noteref" href="notes.xhtml#n">[1]</a></p><figcaption><p>原图注</p><p><span epub:type="credit">原来源</span></p></figcaption></figure><p id="after">末段</p>'
        ),
      ],
      [
        "OPS/notes.xhtml",
        doc('<aside epub:type="footnote" id="n">完整注释</aside>'),
      ],
    ]);
    const result = parseEpubContent(
      docs,
      ["OPS/a.xhtml"],
      [{ title: "末段", target: "OPS/a.xhtml#after", depth: 0 }]
    );
    const c = result.chapters[0];
    expect(c.paragraphs).toEqual([
      "正文😀[1]",
      "[1]",
      "原图注",
      "原来源",
      "末段",
    ]);
    expect(c.footnotes?.map(n => [n.paraIndex, n.start, n.end])).toEqual([
      [0, 4, 7],
      [1, 0, 3],
    ]);
    expect(result.outline[0].paraIndex).toBe(4);
    expect(result.layout.chapters[c.id].items).toEqual([
      { kind: "paragraph", paraIndex: 0 },
      {
        kind: "figure",
        items: [
          { kind: "image", assetId: "OPS/img.png", alt: "Original alt" },
          { kind: "paragraph", paraIndex: 1, role: "image-note" },
          { kind: "paragraph", paraIndex: 2, role: "caption" },
          { kind: "paragraph", paraIndex: 3, role: "credit" },
        ],
      },
      { kind: "paragraph", paraIndex: 4 },
    ]);
  });
  it("records inline images at stable UTF-16 offsets without adding alt text", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc('<p>A😀<img src="i.png" alt="not text"/><img src="j.png"/>B</p>'),
        ],
      ]),
      ["a.xhtml"],
      []
    );
    const c = result.chapters[0];
    expect(c.paragraphs).toEqual(["A😀B"]);
    expect(result.layout.chapters[c.id].items).toEqual([
      {
        kind: "paragraph",
        paraIndex: 0,
        inlineImages: [
          { offset: 3, order: 0, assetId: "i.png", alt: "not text" },
          { offset: 3, order: 1, assetId: "j.png", alt: "" },
        ],
      },
    ]);
  });
  it("retains bare captions and bare image note markers with local full notes", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            '<figure><img src="i.png"/><sup><a epub:type="noteref" href="n.xhtml#n">[1]</a></sup><figcaption>裸图注<span epub:type="credit">来源</span></figcaption></figure>'
          ),
        ],
        ["n.xhtml", doc('<aside id="n" epub:type="footnote">全部内容</aside>')],
      ]),
      ["a.xhtml"],
      [{ title: "图", target: "a.xhtml", depth: 0 }]
    );
    const c = result.chapters[0];
    expect(c.paragraphs).toEqual([]);
    expect(result.layout.chapters[c.id].items).toEqual([
      {
        kind: "figure",
        items: [
          { kind: "image", assetId: "i.png", alt: "" },
          {
            kind: "text",
            text: "[1]",
            notes: [{ start: 0, end: 3, content: "全部内容" }],
            role: "image-note",
          },
          { kind: "text", text: "裸图注", notes: [], role: "caption" },
          { kind: "text", text: "来源", notes: [], role: "credit" },
        ],
      },
    ]);
    expect(result.outline[0].chapterId).toBe(c.id);
    expect(result.outline[0].paraIndex).toBeUndefined();
  });
  it("publishes image-only chapters without synthetic old paragraphs", () => {
    const result = parseEpubContent(
      new Map([["a.xhtml", doc('<p><img src="i.png"/></p>')]]),
      ["a.xhtml"],
      []
    );
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].paragraphs).toEqual([]);
    expect(result.layout.chapters[result.chapters[0].id].items).toEqual([
      { kind: "image", assetId: "i.png", alt: "" },
    ]);
  });
  it("does not truncate valid notes at 20000 characters", () => {
    const content = "注".repeat(21000) + "尾";
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            `<p><a epub:type="noteref" href="#n">1</a></p><aside epub:type="footnote" id="n">${content}</aside>`
          ),
        ],
      ]),
      ["a.xhtml"],
      []
    );
    expect(result.chapters[0].footnotes?.[0].content).toBe(content);
  });
  it("fails explicitly when repeated complete notes exceed the full book budget", () => {
    const content = "注".repeat(800000);
    const refs = Array.from(
      { length: 31 },
      () => '<a epub:type="noteref" href="#n">1</a>'
    ).join("");
    expect(() =>
      parseEpubContent(
        new Map([
          [
            "a.xhtml",
            doc(
              `<p>${refs}</p><aside epub:type="footnote" id="n">${content}</aside>`
            ),
          ],
        ]),
        ["a.xhtml"],
        []
      )
    ).toThrow(/2400/);
  });
  it("reads and deduplicates actual local image bytes, type and dimensions", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
    );
    const result = await parseEpub(
      await book(
        '<p>正文<img src="img.png"/>尾</p><figure><img src="img.png"/></figure>'
      )
    );
    expect(Object.keys(result.epubLayout!.assets)).toEqual(["OPS/img.png"]);
    expect(result.epubLayout!.assets["OPS/img.png"]).toEqual({
      dataUrl: `data:image/png;base64,${btoa(String.fromCharCode(...png))}`,
      mediaType: "image/png",
      width: 1,
      height: 1,
    });
    expect(isEpubLayout(result.epubLayout)).toBe(true);
  });
  it.each([
    "https://example.test/a.png",
    "//host/a.png",
    "file:///a.png",
    "data:image/png;base64,AA==",
    "blob:whatever",
    "../../outside.png",
    "%2foutside.png",
    "%5coutside.png",
    "missing.png",
  ])(
    "rejects unsafe or missing body resource %s without fetching",
    async src => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        parseEpub(await book(`<p>正文<img src="${src}"/></p>`))
      ).rejects.toThrow(/图片|资源|路径/);
      expect(fetch).not.toHaveBeenCalled();
    }
  );
  it("rejects inline SVG in ordinary body rather than silently losing it", async () => {
    await expect(
      parseEpub(
        await book(
          '<p>正文</p><svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
        )
      )
    ).rejects.toThrow(/SVG|图片/);
  });
  it("rejects corrupt image data before publishing", async () => {
    await expect(
      parseEpub(
        await book('<p><img src="img.png"/></p>', {
          image: new Uint8Array([1, 2, 3]),
        })
      )
    ).rejects.toThrow(/图片/);
  });
  it("excludes only cover nodes, preserving body images in the same document", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
    );
    const result = await parseEpub(
      await book(
        '<section epub:type="cover"><svg xmlns="http://www.w3.org/2000/svg"/></section><p>正文</p><figure><img src="img.png"/><figcaption><p>图注</p></figcaption></figure>',
        { guide: "a.xhtml#front" }
      )
    );
    expect(result.chapters[0].paragraphs).toEqual(["正文", "图注"]);
    expect(Object.keys(result.epubLayout!.assets)).toEqual(["OPS/img.png"]);
  });
  it("limits guide cover fragments to their actual target subtree", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
    );
    const result = await parseEpub(
      await book(
        '<section id="front"><svg xmlns="http://www.w3.org/2000/svg"/></section><p>正文<img src="img.png"/></p>',
        { guide: "a.xhtml#front" }
      )
    );
    expect(result.chapters[0].paragraphs).toEqual(["正文"]);
    expect(Object.keys(result.epubLayout!.assets)).toEqual(["OPS/img.png"]);
  });
  it("does not produce unsupported nested figure nodes", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            '<figure><img src="i.png"/><figure><img src="j.png"/><figcaption>Caption</figcaption></figure></figure>'
          ),
        ],
      ]),
      ["a.xhtml"],
      []
    );
    const figure = result.layout.chapters[result.chapters[0].id].items[0];
    expect(figure).toEqual({
      kind: "figure",
      items: [
        { kind: "image", assetId: "i.png", alt: "" },
        { kind: "image", assetId: "j.png", alt: "" },
        { kind: "text", text: "Caption", notes: [], role: "caption" },
      ],
    });
  });
  it("excludes an explicitly marked cover body without filtering a body chapter", () => {
    const cover = doc('<svg xmlns="http://www.w3.org/2000/svg"/>');
    cover
      .querySelector("body")!
      .setAttributeNS("http://www.idpf.org/2007/ops", "epub:type", "cover");
    const result = parseEpubContent(
      new Map([
        ["cover.xhtml", cover],
        ["a.xhtml", doc('<p>正文<img src="i.png"/></p>')],
      ]),
      ["cover.xhtml", "a.xhtml"],
      []
    );
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].paragraphs).toEqual(["正文"]);
  });
  it("maps an image-only chapter's exact image ID to its chapter top", () => {
    const result = parseEpubContent(
      new Map([["a.xhtml", doc('<img id="plate" src="i.png"/>')]]),
      ["a.xhtml"],
      [{ title: "Plate", target: "a.xhtml#plate", depth: 0 }]
    );
    expect(result.outline[0].chapterId).toBe(result.chapters[0].id);
    expect(result.outline[0].paraIndex).toBeUndefined();
  });
  it("rejects excess repeated image occurrences before making an unusable cache", () => {
    const markup = '<img src="i.png"/>'.repeat(50001);
    expect(() =>
      parseEpubContent(new Map([["a.xhtml", doc(markup)]]), ["a.xhtml"], [])
    ).toThrow(/过多/);
  });
  it("retains linked or span-wrapped figure images in their original text order", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            '<figure><a href="https://example.test/"><img src="i.png" alt="Linked"/></a><span>甲<img src="j.png"/>乙</span><figcaption>图注</figcaption></figure>'
          ),
        ],
      ]),
      ["a.xhtml"],
      []
    );
    expect(result.layout.chapters[result.chapters[0].id].items).toEqual([
      {
        kind: "figure",
        items: [
          { kind: "image", assetId: "i.png", alt: "Linked" },
          { kind: "text", text: "甲", notes: [] },
          { kind: "image", assetId: "j.png", alt: "" },
          { kind: "text", text: "乙", notes: [] },
          { kind: "text", text: "图注", notes: [], role: "caption" },
        ],
      },
    ]);
  });
  it("keeps wrapped inline caption images and rebases local note ranges", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            '<figure><img src="i.png"/><figcaption><span>甲<img src="j.png"/>乙<a epub:type="noteref" href="#n">[1]</a></span></figcaption></figure><aside id="n" epub:type="footnote">完整内容</aside>'
          ),
        ],
      ]),
      ["a.xhtml"],
      []
    );
    expect(result.layout.chapters[result.chapters[0].id].items).toEqual([
      {
        kind: "figure",
        items: [
          { kind: "image", assetId: "i.png", alt: "" },
          { kind: "text", text: "甲", notes: [], role: "caption" },
          { kind: "image", assetId: "j.png", alt: "" },
          {
            kind: "text",
            text: "乙[1]",
            notes: [{ start: 1, end: 4, content: "完整内容" }],
            role: "caption",
          },
        ],
      },
    ]);
  });
  it("marks explicitly declared caption paragraphs without guessing nearby body text", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc(
            '<p><img src="i.png"/></p><p class="caption">KnownCaption</p><p>Ordinary text</p>'
          ),
        ],
      ]),
      ["a.xhtml"],
      []
    );
    expect(result.layout.chapters[result.chapters[0].id].items).toEqual([
      { kind: "image", assetId: "i.png", alt: "" },
      { kind: "paragraph", paraIndex: 0, role: "caption" },
      { kind: "paragraph", paraIndex: 1 },
    ]);
  });
});

describe("EPUB layout shape and image budget validation", () => {
  it("sniffs PNG dimensions from bytes and rejects excess dimensions", () => {
    expect(inspectEpubImage(png)).toEqual({
      mediaType: "image/png",
      width: 1,
      height: 1,
    });
    const huge = png.slice();
    new DataView(huge.buffer).setUint32(16, 16385);
    expect(() => inspectEpubImage(huge)).toThrow(/尺寸|像素/);
  });
  it("rejects oversized image bytes", () => {
    expect(() =>
      inspectEpubImage(new Uint8Array(12 * 1024 * 1024 + 1))
    ).toThrow(/12|图片/);
  });
  it("rejects decoder failures and does not fetch fallback resources", async () => {
    const decode = vi.fn(async () => {
      throw new Error("corrupt");
    });
    const fetch = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal("fetch", fetch);
    await expect(readEpubImage(png)).rejects.toThrow(/解码/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects total bytes, asset count, duplicate paragraphs and bad image offsets", () => {
    const asset = {
      mediaType: "image/png",
      dataUrl: "data:image/png;base64," + "AAAA".repeat(4 * 1024 * 1024),
    };
    expect(
      isEpubLayout({
        version: 1,
        assets: { a: asset, b: asset, c: asset },
        chapters: {},
      })
    ).toBe(false);
    expect(
      isEpubLayout({
        version: 1,
        assets: Object.fromEntries(
          Array.from({ length: 2001 }, (_, i) => [
            i,
            { mediaType: "image/png", dataUrl: "data:image/png;base64,AA==" },
          ])
        ),
        chapters: {},
      })
    ).toBe(false);
    const valid = {
      version: 1,
      assets: {
        i: { mediaType: "image/png", dataUrl: "data:image/png;base64,AA==" },
      },
      chapters: {
        c: {
          items: [
            { kind: "paragraph", paraIndex: 0 },
            { kind: "paragraph", paraIndex: 0 },
          ],
        },
      },
    };
    expect(isEpubLayout(valid)).toBe(false);
    expect(
      isEpubLayout({
        ...valid,
        chapters: {
          c: {
            items: [
              {
                kind: "paragraph",
                paraIndex: 0,
                inlineImages: [{ offset: -1, order: 0, assetId: "i", alt: "" }],
              },
            ],
          },
        },
      })
    ).toBe(false);
  });
  it("accepts only bounded data-image assets and existing asset references", () => {
    const valid = {
      version: 1,
      assets: {
        i: {
          dataUrl: "data:image/png;base64,AA==",
          mediaType: "image/png",
          width: 1,
          height: 1,
        },
      },
      chapters: {
        c: {
          items: [
            {
              kind: "paragraph",
              paraIndex: 0,
              inlineImages: [{ offset: 1, order: 0, assetId: "i", alt: "" }],
            },
          ],
        },
      },
    };
    expect(isEpubLayout(valid)).toBe(true);
    expect(isEpubLayout({ ...valid, version: 2 })).toBe(false);
    expect(
      isEpubLayout({
        ...valid,
        assets: { i: { ...valid.assets.i, dataUrl: "https://example.test/x" } },
      })
    ).toBe(false);
    expect(
      isEpubLayout({
        ...valid,
        chapters: {
          c: { items: [{ kind: "image", assetId: "missing", alt: "" }] },
        },
      })
    ).toBe(false);
    expect(
      isEpubLayout({
        ...valid,
        chapters: {
          c: {
            items: [
              {
                kind: "text",
                text: "x",
                notes: [{ start: 0, end: 2, content: "n" }],
              },
            ],
          },
        },
      })
    ).toBe(false);
  });
});
