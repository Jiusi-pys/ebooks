import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_READER_PANEL_CONTENT_MODE,
  loadReaderPanelContentMode,
  parseReaderPanelContentMode,
  READER_PANEL_CONTENT_MODE_STORAGE_KEY,
  saveReaderPanelContentMode,
} from "./readerPanelContentMode";

describe("reader panel content mode", () => {
  it("accepts the separate and combined views and safely defaults invalid data", () => {
    expect(parseReaderPanelContentMode("separate")).toBe("separate");
    expect(parseReaderPanelContentMode("combined")).toBe("combined");
    expect(parseReaderPanelContentMode("legacy")).toBe(
      DEFAULT_READER_PANEL_CONTENT_MODE
    );
  });

  it("persists the selected content view independently", () => {
    const storage = {
      getItem: vi.fn(() => "combined"),
      setItem: vi.fn(),
    };

    expect(loadReaderPanelContentMode(storage)).toBe("combined");
    saveReaderPanelContentMode("separate", storage);

    expect(storage.getItem).toHaveBeenCalledWith(
      READER_PANEL_CONTENT_MODE_STORAGE_KEY
    );
    expect(storage.setItem).toHaveBeenCalledWith(
      READER_PANEL_CONTENT_MODE_STORAGE_KEY,
      "separate"
    );
  });
});
