import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Library } from "@/hooks/useLibrary";
import type { SidebarMode } from "@/lib/sidebarMode";
import type { Book } from "@/types";
import { Sidebar } from "./Sidebar";

const lib = {
  route: { view: "library" },
  books: [],
  notes: [],
  highlights: [],
  mindMaps: [],
  studySets: [],
  navigate: vi.fn(),
  importFiles: vi.fn(),
} as unknown as Library;

function renderSidebar(mode: SidebarMode, mobile = false, books: Book[] = []) {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      lib: { ...lib, books },
      userId: "local-reader",
      mode,
      open: true,
      floating: mode === "auto" || mobile,
      mobile,
      onModeChange: vi.fn(),
      onNavigate: vi.fn(),
      onRequestClose: vi.fn(),
      onInteractionStart: vi.fn(),
      onInteractionEnd: vi.fn(),
      onUpdateProfile: vi.fn(async () => undefined),
      onLogout: vi.fn(async () => undefined),
    })
  );
}

describe("Sidebar display mode control", () => {
  it("renders one icon that switches pinned mode to auto-hide", () => {
    const html = renderSidebar("pinned");

    expect(html).toContain('aria-label="切换为自动隐藏"');
    expect(html.match(/aria-pressed=/g)).toHaveLength(1);
    expect(html).not.toContain("侧栏显示方式");
    expect(html).not.toContain("保持隐藏");
  });

  it("offers pinning as the single mode action while auto-hidden", () => {
    const html = renderSidebar("auto");

    expect(html).toContain('aria-label="固定显示侧栏"');
    expect(html.match(/aria-pressed=/g)).toHaveLength(1);
  });

  it("keeps the mobile close action instead of a desktop mode control", () => {
    const html = renderSidebar("auto", true);

    expect(html).toContain('aria-label="关闭侧栏"');
    expect(html).not.toContain("固定显示侧栏");
    expect(html).not.toContain("切换为自动隐藏");
  });

  it("keeps navigation names available as hover labels while showing icons by default", () => {
    const html = renderSidebar("pinned");

    expect(html).toContain('aria-label="书架"');
    expect(html).toContain('title="书架"');
    expect(html).toContain('class="sr-only">书架</span>');
  });

  it("shows reading items from most recently opened to oldest", () => {
    const book = (
      id: string,
      createdAt: number,
      lastOpenedAt?: number
    ): Book => ({
      id,
      title: id,
      author: "",
      format: "txt",
      coverTone: 0,
      chapters: [],
      createdAt,
      lastOpenedAt,
      progress: { chapterId: "", ratio: 0 },
    });
    const html = renderSidebar("pinned", false, [
      book("older-opened", 30, 100),
      book("latest-opened", 10, 300),
      book("never-opened", 200),
    ]);

    expect(html.indexOf("latest-opened")).toBeLessThan(
      html.indexOf("older-opened")
    );
    expect(html.indexOf("older-opened")).toBeLessThan(
      html.indexOf("never-opened")
    );
  });
});
