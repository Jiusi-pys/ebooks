import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIDEBAR_MODE,
  loadSidebarMode,
  parseSidebarMode,
  saveSidebarMode,
  sidebarIsVisible,
  sidebarOccupiesLayout,
  SIDEBAR_MODE_STORAGE_KEY,
  toggleSidebarMode,
} from "./sidebarMode";

describe("sidebar mode", () => {
  it("accepts the two supported values and migrates legacy hidden mode", () => {
    expect(parseSidebarMode("pinned")).toBe("pinned");
    expect(parseSidebarMode("auto")).toBe("auto");
    expect(parseSidebarMode("hidden")).toBe("auto");
    expect(parseSidebarMode("collapsed")).toBe(DEFAULT_SIDEBAR_MODE);
    expect(parseSidebarMode(null)).toBe(DEFAULT_SIDEBAR_MODE);
  });

  it("loads and saves through the versioned storage key", () => {
    const storage = {
      getItem: vi.fn(() => "auto"),
      setItem: vi.fn(),
    };

    expect(loadSidebarMode(storage)).toBe("auto");
    saveSidebarMode("pinned", storage);

    expect(storage.getItem).toHaveBeenCalledWith(SIDEBAR_MODE_STORAGE_KEY);
    expect(storage.setItem).toHaveBeenCalledWith(
      SIDEBAR_MODE_STORAGE_KEY,
      "pinned"
    );
  });

  it("toggles directly between pinned and auto-hide", () => {
    expect(toggleSidebarMode("pinned")).toBe("auto");
    expect(toggleSidebarMode("auto")).toBe("pinned");
  });

  it("falls back safely when storage access fails", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    expect(loadSidebarMode(storage)).toBe(DEFAULT_SIDEBAR_MODE);
    expect(() => saveSidebarMode("auto", storage)).not.toThrow();
  });

  it("reserves desktop layout space only for pinned mode", () => {
    expect(sidebarOccupiesLayout("pinned", false)).toBe(true);
    expect(sidebarOccupiesLayout("auto", false)).toBe(false);
    expect(sidebarOccupiesLayout("pinned", true)).toBe(false);
  });

  it("uses an independent overlay state outside pinned desktop mode", () => {
    expect(sidebarIsVisible("pinned", false, false, false)).toBe(true);
    expect(sidebarIsVisible("auto", false, false, false)).toBe(false);
    expect(sidebarIsVisible("auto", true, false, false)).toBe(true);
    expect(sidebarIsVisible("pinned", false, false, true)).toBe(false);
    expect(sidebarIsVisible("auto", false, true, true)).toBe(true);
  });
});
