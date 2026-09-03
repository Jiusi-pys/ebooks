import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { initFb2File } from "@lingo-reader/fb2-parser";
import { describe, expect, it } from "vitest";
import { prepareFb2Xml } from "./parseFb2";

const FB2_WITH_CODE = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <stylesheet type="text/css">p { color: red; }</stylesheet>
  <description>
    <title-info>
      <book-title>代码 &lt;示例&gt;</book-title>
      <author><first-name>测试</first-name><last-name>作者</last-name></author>
      <lang>zh</lang>
    </title-info>
    <document-info>
      <author><first-name>测试</first-name><last-name>作者</last-name></author>
      <history><p><image l:href="#unused"/></p></history>
    </document-info>
  </description>
  <body>
    <section>
      <title><p>第一章</p></title>
      <p>字面代码：&lt;script&gt;alert(1)&lt;/script&gt;</p>
    </section>
  </body>
</FictionBook>`;

describe("prepareFb2Xml", () => {
  it("removes initialization-only resources and protects escaped markup", () => {
    const prepared = prepareFb2Xml(FB2_WITH_CODE);

    expect(prepared).not.toMatch(/<(?:stylesheet|history)\b/i);
    expect(prepared).toContain("<book-title>代码 &lt;示例&gt;</book-title>");
    expect(prepared).toContain(
      "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;"
    );
  });

  it("keeps escaped script examples as entities through the upstream serializer", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "books-fb2-test-"));
    let parser: Awaited<ReturnType<typeof initFb2File>> | undefined;
    try {
      parser = await initFb2File(
        Buffer.from(prepareFb2Xml(FB2_WITH_CODE), "utf8"),
        outputDir
      );
      const chapterId = parser.getSpine()[0]?.id;
      const html = chapterId ? parser.loadChapter(chapterId)?.html : undefined;

      expect(parser.getMetadata().title).toBe("代码 <示例>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>");
    } finally {
      parser?.destroy();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
