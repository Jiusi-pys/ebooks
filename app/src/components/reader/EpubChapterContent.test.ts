// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chapter } from "@/types";
import { EpubChapterContent } from "./EpubChapterContent";
import { EpubText } from "./EpubText";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  document.body.innerHTML = "";
});

const asset = {
  mediaType: "image/png",
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  width: 1,
  height: 1,
};

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("EPUB chapter visual layout", () => {
  it("keeps a picture immediately before its marker outside the note button", async () => {
    const { host, close } = await mount(
      createElement(EpubText, {
        text: "[1]",
        notes: [{ paraIndex: 0, start: 0, end: 3, content: "图注释" }],
        images: [{ offset: 0, order: 0, assetId: "image", alt: "图", asset }],
      })
    );
    try {
      expect(host.querySelector("img")?.closest("button, sup")).toBeNull();
      expect(host.querySelector("button")?.textContent).toBe("[1]");
      expect(host.querySelector("img")?.nextElementSibling?.tagName).toBe(
        "SUP"
      );
    } finally {
      await close();
    }
  });
  it("renders original paragraph indices once and keeps image notes beside the image", async () => {
    const chapter: Chapter = {
      id: "chapter",
      title: "标题",
      paragraphs: ["正文", "[2]", "图 1 原图注", "来源：原来源", "图后正文"],
      footnotes: [{ paraIndex: 1, start: 0, end: 3, content: "图片注释全文" }],
    };
    const rendered: number[] = [];
    const { host, close } = await mount(
      createElement(EpubChapterContent, {
        chapter,
        layout: {
          version: 1,
          assets: { image: asset },
          chapters: {
            chapter: {
              items: [
                { kind: "paragraph", paraIndex: 0 },
                {
                  kind: "figure",
                  items: [
                    { kind: "image", assetId: "image", alt: "原始替代文本" },
                    { kind: "paragraph", paraIndex: 1, role: "image-note" },
                    { kind: "paragraph", paraIndex: 2, role: "caption" },
                    { kind: "paragraph", paraIndex: 3, role: "credit" },
                  ],
                },
                { kind: "paragraph", paraIndex: 4 },
              ],
            },
          },
        },
        renderParagraph: (index, context) => {
          rendered.push(index);
          return createElement(
            "p",
            { "data-pi": index, "data-role": context.role },
            createElement(EpubText, {
              text: chapter.paragraphs[index],
              notes: chapter.footnotes?.filter(n => n.paraIndex === index),
              images: context.images,
            })
          );
        },
      })
    );
    try {
      expect(rendered).toEqual([0, 1, 2, 3, 4]);
      expect(host.textContent).toBe(chapter.paragraphs.join(""));
      expect(
        [...host.querySelectorAll("[data-pi]")].map(p =>
          p.getAttribute("data-pi")
        )
      ).toEqual(["0", "1", "2", "3", "4"]);
      const figure = host.querySelector("figure")!;
      expect(figure.querySelector("img")?.alt).toBe("原始替代文本");
      expect(figure.querySelector("figcaption")?.textContent).toBe(
        "图 1 原图注来源：原来源"
      );
      expect(figure.lastElementChild?.tagName).toBe("FIGCAPTION");
      expect(
        figure.querySelector('button[aria-label="查看注释 [2]"]')
      ).not.toBeNull();
      await act(async () =>
        (figure.querySelector("button") as HTMLButtonElement).click()
      );
      expect(
        document.querySelector('[aria-label="书内注释"]')?.textContent
      ).toContain("图片注释全文");
    } finally {
      await close();
    }
  });

  it("keeps bare caption and bare image-note text without inventing paragraph indices", async () => {
    const { host, close } = await mount(
      createElement(EpubChapterContent, {
        chapter: { id: "picture-only", title: "插图", paragraphs: [] },
        layout: {
          version: 1,
          assets: { image: asset },
          chapters: {
            "picture-only": {
              items: [
                {
                  kind: "figure",
                  items: [
                    { kind: "image", assetId: "image", alt: "插图" },
                    {
                      kind: "text",
                      text: "[1]",
                      role: "image-note",
                      notes: [{ start: 0, end: 3, content: "裸图片注释" }],
                    },
                    {
                      kind: "text",
                      text: "原图注",
                      role: "caption",
                      notes: [],
                    },
                  ],
                },
              ],
            },
          },
        },
      })
    );
    try {
      expect(host.querySelectorAll("img")).toHaveLength(1);
      expect(host.querySelectorAll("[data-pi]")).toHaveLength(0);
      expect(host.textContent).toBe("[1]原图注");
      expect(host.querySelector("figcaption")?.textContent).toBe("原图注");
      await act(async () =>
        (host.querySelector("button") as HTMLButtonElement).click()
      );
      expect(
        document.querySelector('[aria-label="书内注释"]')?.textContent
      ).toContain("裸图片注释");
    } finally {
      await close();
    }
  });

  it("retains the text-only fallback for old books", async () => {
    const { host, close } = await mount(
      createElement(EpubChapterContent, {
        chapter: { id: "old", title: "旧书", paragraphs: ["第一段", "第二段"] },
      })
    );
    try {
      expect(host.textContent).toBe("第一段第二段");
      expect(host.querySelectorAll("[data-pi]")).toHaveLength(2);
      expect(host.querySelector("img")).toBeNull();
    } finally {
      await close();
    }
  });

  it("keeps inline image positions across text segments without duplicate boundary images", async () => {
    const images = [
      { offset: 3, order: 0, assetId: "image", alt: "行内图", asset },
    ];
    const { host, close } = await mount(
      createElement(
        "p",
        {},
        createElement(EpubText, {
          text: "A😀",
          offset: 0,
          images,
          endOfParagraph: false,
        }),
        createElement(EpubText, {
          text: "B[1]",
          offset: 3,
          images,
          notes: [{ paraIndex: 0, start: 4, end: 7, content: "行内注释" }],
        })
      )
    );
    try {
      expect(host.textContent).toBe("A😀B[1]");
      expect(host.querySelectorAll("img")).toHaveLength(1);
      const img = host.querySelector("img")!;
      expect(img.previousSibling?.textContent).toBe("A😀");
      expect(img.nextSibling?.textContent).toBe("B");
      expect(host.querySelector("sup button")?.textContent).toBe("[1]");
    } finally {
      await close();
    }
  });

  it("renders images at the paragraph end once and keeps note clicks out of the reader", async () => {
    const parentClick = vi.fn();
    const { host, close } = await mount(
      createElement(
        "div",
        { onClick: parentClick },
        createElement(EpubText, {
          text: "[1]",
          images: [
            { offset: 3, order: 0, assetId: "image", alt: "末尾图", asset },
          ],
          notes: [{ paraIndex: 0, start: 0, end: 3, content: "正确注释" }],
        })
      )
    );
    try {
      expect(host.querySelectorAll("img")).toHaveLength(1);
      await act(async () =>
        (host.querySelector("button") as HTMLButtonElement).click()
      );
      expect(parentClick).not.toHaveBeenCalled();
      expect(
        document.querySelector('[aria-label="书内注释"]')?.textContent
      ).toContain("正确注释");
    } finally {
      await close();
    }
  });
});
