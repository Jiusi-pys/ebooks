// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseEpubContent, readEpubToc } from "./epubContent";

const doc = (body: string) =>
  new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>test</title></head><body>${body}</body></html>`,
    "application/xhtml+xml"
  );

describe("EPUB navigation and notes", () => {
  it("resolves empty anchor elements placed before a paragraph", () => {
    const result = parseEpubContent(
      new Map([["a.xhtml", doc('<p>第一段</p><a id="second"/><p>第二段</p>')]]),
      ["a.xhtml"],
      [{ title: "第二段", target: "a.xhtml#second", depth: 0 }]
    );
    expect(result.outline[0].paraIndex).toBe(1);
  });
  it("retains exact paragraph targets, repeated labels and nested TOC depth", () => {
    const nav = doc(
      '<nav epub:type="toc"><ol><li><a href="text/a.xhtml#one">重复</a><ol><li><a href="text/a.xhtml#two">重复</a></li></ol></li></ol></nav><nav epub:type="landmarks"><a href="wrong">封面</a></nav>'
    );
    const toc = readEpubToc(nav, "OPS/nav.xhtml");
    const result = parseEpubContent(
      new Map([
        [
          "OPS/text/a.xhtml",
          doc('<h1>标题</h1><p id="one">第一段</p><p id="two">第二段</p>'),
        ],
      ]),
      ["OPS/text/a.xhtml"],
      toc
    );
    expect(result.outline.map(i => [i.title, i.paraIndex, i.depth])).toEqual([
      ["重复", 0, 0],
      ["重复", 1, 1],
    ]);
    expect(
      result.outline.every(i => i.chapterId === result.chapters[0].id)
    ).toBe(true);
  });

  it("resolves cross-file notes outside spine without flattening them into body", () => {
    const docs = new Map([
      [
        "OPS/a.xhtml",
        doc(
          '<h1 id="head">标题</h1><p>正文<a epub:type="noteref" href="notes.xhtml#n1">[1]</a>继续<a role="doc-noteref" href="notes.xhtml#n1">[1]</a></p>'
        ),
      ],
      [
        "OPS/notes.xhtml",
        doc(
          '<aside epub:type="footnote" id="n1"><p>注释内容 <a epub:type="backlink" href="a.xhtml#head">返回</a></p><script>bad()</script></aside>'
        ),
      ],
    ]);
    const result = parseEpubContent(docs, ["OPS/a.xhtml"], []);
    const chapter = result.chapters[0];
    expect(chapter.footnotes).toHaveLength(2);
    for (const note of chapter.footnotes!) {
      expect(
        chapter.paragraphs[note.paraIndex].slice(note.start, note.end).trim()
      ).toBe("[1]");
      expect(note.content).toBe("注释内容");
    }
    expect(chapter.paragraphs).toEqual(["正文[1]继续[1]"]);
  });

  it("keeps missing refs readable and broken TOC entries non-navigating", () => {
    const result = parseEpubContent(
      new Map([
        [
          "a.xhtml",
          doc('<p>原文<a epub:type="noteref" href="#missing">[9]</a></p>'),
        ],
      ]),
      ["a.xhtml"],
      [{ title: "不存在", target: "a.xhtml#missing", depth: 0 }]
    );
    expect(result.chapters[0].paragraphs[0]).toContain("[9]");
    expect(result.chapters[0].footnotes ?? []).toHaveLength(0);
    expect(result.outline[0].chapterId).toBeUndefined();
  });

  it("maps encoded anchors, heading splits and wrapper IDs", () => {
    const result = parseEpubContent(
      new Map([
        [
          "章.xhtml",
          doc(
            '<section id="一"><h1>甲</h1><p>甲正文</p></section><h2 id="二">乙</h2><p>乙正文</p>'
          ),
        ],
      ]),
      ["章.xhtml"],
      [
        { title: "甲", target: "章.xhtml#一", depth: 0 },
        { title: "乙", target: "章.xhtml#二", depth: 0 },
      ]
    );
    expect(result.chapters).toHaveLength(2);
    expect(result.outline.map(i => i.chapterId)).toEqual(
      result.chapters.map(c => c.id)
    );
  });

  it("retains NCX hierarchy and file fragments", () => {
    const ncx = new DOMParser().parseFromString(
      '<ncx><navMap><navPoint><navLabel><text>A</text></navLabel><content src="a.xhtml#one"/><navPoint><navLabel><text>B</text></navLabel><content src="a.xhtml#two"/></navPoint></navPoint></navMap></ncx>',
      "application/xml"
    );
    expect(readEpubToc(ncx, "OPS/toc.ncx")).toEqual([
      { title: "A", target: "OPS/a.xhtml#one", depth: 0 },
      { title: "B", target: "OPS/a.xhtml#two", depth: 1 },
    ]);
  });
});
