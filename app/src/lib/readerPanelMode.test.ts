import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_READER_PANEL_MODE,
  loadReaderPanelMode,
  parseReaderPanelMode,
  readerPanelIsVisible,
  readerPanelOccupiesLayout,
  READER_PANEL_MODE_STORAGE_KEY,
  saveReaderPanelMode,
  toggleReaderPanelMode,
} from "./readerPanelMode";
import { SIDEBAR_MODE_STORAGE_KEY } from "./sidebarMode";

describe("reader right panel mode", () => {
  it("supports only pinned and auto-hide and migrates legacy hidden", () => {
    expect(parseReaderPanelMode("pinned")).toBe("pinned");
    expect(parseReaderPanelMode("auto")).toBe("auto");
    expect(parseReaderPanelMode("hidden")).toBe("auto");
    expect(parseReaderPanelMode("closed")).toBe(DEFAULT_READER_PANEL_MODE);
  });

  it("uses a storage key independent from the main sidebar", () => {
    expect(READER_PANEL_MODE_STORAGE_KEY).not.toBe(SIDEBAR_MODE_STORAGE_KEY);
    const storage = {
      getItem: vi.fn(() => "auto"),
      setItem: vi.fn(),
    };

    expect(loadReaderPanelMode(storage)).toBe("auto");
    saveReaderPanelMode("pinned", storage);

    expect(storage.getItem).toHaveBeenCalledWith(READER_PANEL_MODE_STORAGE_KEY);
    expect(storage.setItem).toHaveBeenCalledWith(
      READER_PANEL_MODE_STORAGE_KEY,
      "pinned"
    );
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

    expect(loadReaderPanelMode(storage)).toBe(DEFAULT_READER_PANEL_MODE);
    expect(() => saveReaderPanelMode("auto", storage)).not.toThrow();
  });

  it("reserves layout only for a pinned wide-screen panel", () => {
    expect(readerPanelOccupiesLayout("pinned", true)).toBe(true);
    expect(readerPanelOccupiesLayout("auto", true)).toBe(false);
    expect(readerPanelOccupiesLayout("pinned", false)).toBe(false);
  });

  it("keeps a transient overlay reachable on narrow and auto modes", () => {
    expect(readerPanelIsVisible(true, "pinned", false)).toBe(true);
    expect(readerPanelIsVisible(true, "auto", false)).toBe(false);
    expect(readerPanelIsVisible(true, "auto", true)).toBe(true);
    expect(readerPanelIsVisible(true, "pinned", true)).toBe(true);
    expect(readerPanelIsVisible(false, "pinned", true)).toBe(false);
    expect(toggleReaderPanelMode("pinned")).toBe("auto");
  });
});
