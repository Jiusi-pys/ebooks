import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Library } from "@/hooks/useLibrary";
import type { SidebarMode } from "@/lib/sidebarMode";
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

function renderSidebar(mode: SidebarMode, mobile = false) {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      lib,
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
});
