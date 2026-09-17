// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { parseEpub } from "./parseEpub";
import { OutlinePanel } from "@/components/reader/OutlinePanel";
import { EpubText } from "@/components/reader/EpubText";
import type { Book, ReaderTheme } from "@/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Plugin EPUB to reader", () => {
  it("imports an actual plugin-produced ZIP, navigates to paragraph and displays the note in place", async () => {
    const bytes = readFileSync("src/lib/fixtures/epub-editor.epub");
    const file = {
      name: "epub-editor.epub",
      size: bytes.length,
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    } as File;
    const parsed = await parseEpub(file);
    const book: Book = {
      ...parsed,
      id: "integration",
      format: "epub",
      coverTone: 0,
      createdAt: 1,
      progress: { chapterId: parsed.chapters[0].id, ratio: 0 },
    };
    const navigate = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(
            "div",
            {},
            createElement(OutlinePanel, {
              book,
              activeChapterId: book.chapters[0].id,
              theme: {} as ReaderTheme,
              onNavigate: navigate,
              onChange: vi.fn(),
            }),
            createElement(
              "p",
              {},
              createElement(EpubText, {
                text: book.chapters[0].paragraphs[0],
                notes: book.chapters[0].footnotes,
              })
            )
          )
        )
      );
      await act(async () =>
        (
          host.querySelector('[title="跳转到：第二段"]') as HTMLButtonElement
        ).click()
      );
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          chapterId: book.chapters[0].id,
          paraIndex: 1,
        })
      );
      await act(async () =>
        (
          host.querySelector('[aria-label="查看注释 [1]"]') as HTMLButtonElement
        ).click()
      );
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "注释的内容"
      );
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
