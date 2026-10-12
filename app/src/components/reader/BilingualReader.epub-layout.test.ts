// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { BilingualReader } from "./BilingualReader";
import { DEFAULT_TYPE, themeById } from "@/lib/reading";
import type { Book } from "@/types";
import type { EpubLayout } from "@/lib/epubLayout";

const stable = vi.hoisted(() => ({ utils: {}, config: {} }));
vi.mock("@/lib/trpc-client", () => ({
  trpc: { useUtils: () => stable.utils },
}));
vi.mock("@/lib/aiConfig", () => ({ useAiConfig: () => [stable.config] }));
vi.mock("@/lib/db", () => ({
  getChapterTranslation: async () => ({ text: "Translated paragraph." }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanel: ({ children }: { children: ReactNode }) => children,
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => children,
  ResizableHandle: () => null,
}));

const book: Book = {
  id: "book",
  title: "Book",
  author: "",
  format: "epub",
  coverTone: 0,
  createdAt: 1,
  chapters: [
    { id: "chapter", title: "Chapter", paragraphs: ["Original paragraph."] },
  ],
  progress: { chapterId: "chapter", ratio: 0.5 },
};
const layout: EpubLayout = {
  version: 1,
  assets: {},
  chapters: { chapter: { items: [{ kind: "paragraph", paraIndex: 0 }] } },
};

describe("bilingual EPUB layout refresh", () => {
  it("does not re-enter the chapter or reset translated scrolling for a cloned sidecar", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const scrolled: HTMLElement[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTo"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: function (this: HTMLElement) {
        scrolled.push(this);
      },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0)
    );
    vi.stubGlobal("cancelAnimationFrame", window.clearTimeout.bind(window));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (value: EpubLayout) =>
      createElement(BilingualReader, {
        book,
        epubLayout: value,
        theme: themeById("warm"),
        type: DEFAULT_TYPE,
        onNavigateChapter: vi.fn(),
      });
    try {
      await act(async () => {
        root.render(render(layout));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      scrolled.length = 0;
      await act(async () => {
        root.render(render(structuredClone(layout)));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      expect(scrolled).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      if (descriptor)
        Object.defineProperty(HTMLElement.prototype, "scrollTo", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });
});
