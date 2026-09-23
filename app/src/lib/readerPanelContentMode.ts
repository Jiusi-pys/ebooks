export type ReaderPanelContentMode = "separate" | "combined";

export const DEFAULT_READER_PANEL_CONTENT_MODE: ReaderPanelContentMode =
  "separate";
export const READER_PANEL_CONTENT_MODE_STORAGE_KEY =
  "shufang-reader-right-panel-content-mode-v1";

interface ReaderPanelContentModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseReaderPanelContentMode(
  value: string | null
): ReaderPanelContentMode {
  return value === "combined" || value === "separate"
    ? value
    : DEFAULT_READER_PANEL_CONTENT_MODE;
}

export function loadReaderPanelContentMode(
  storage: ReaderPanelContentModeStorage | undefined = typeof localStorage ===
  "undefined"
    ? undefined
    : localStorage
): ReaderPanelContentMode {
  if (!storage) return DEFAULT_READER_PANEL_CONTENT_MODE;
  try {
    return parseReaderPanelContentMode(
      storage.getItem(READER_PANEL_CONTENT_MODE_STORAGE_KEY)
    );
  } catch {
    return DEFAULT_READER_PANEL_CONTENT_MODE;
  }
}

export function saveReaderPanelContentMode(
  mode: ReaderPanelContentMode,
  storage: ReaderPanelContentModeStorage | undefined = typeof localStorage ===
  "undefined"
    ? undefined
    : localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(READER_PANEL_CONTENT_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in private browsing or restricted webviews.
  }
}
