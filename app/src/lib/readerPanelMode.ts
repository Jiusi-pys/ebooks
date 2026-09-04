import {
  parseSidebarMode,
  toggleSidebarMode,
  type SidebarMode,
} from "./sidebarMode";

export type ReaderPanelMode = SidebarMode;

export const DEFAULT_READER_PANEL_MODE: ReaderPanelMode = "pinned";
export const READER_PANEL_MODE_STORAGE_KEY =
  "shufang-reader-right-panel-mode-v1";

interface ReaderPanelModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseReaderPanelMode(value: string | null): ReaderPanelMode {
  return parseSidebarMode(value);
}

export function toggleReaderPanelMode(mode: ReaderPanelMode): ReaderPanelMode {
  return toggleSidebarMode(mode);
}

export function loadReaderPanelMode(
  storage: ReaderPanelModeStorage | undefined = typeof localStorage ===
  "undefined"
    ? undefined
    : localStorage
): ReaderPanelMode {
  if (!storage) return DEFAULT_READER_PANEL_MODE;
  try {
    return parseReaderPanelMode(storage.getItem(READER_PANEL_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_READER_PANEL_MODE;
  }
}

export function saveReaderPanelMode(
  mode: ReaderPanelMode,
  storage: ReaderPanelModeStorage | undefined = typeof localStorage ===
  "undefined"
    ? undefined
    : localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(READER_PANEL_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in private browsing or restricted webviews.
  }
}

export function readerPanelOccupiesLayout(
  mode: ReaderPanelMode,
  wideScreen: boolean
): boolean {
  return mode === "pinned" && wideScreen;
}

export function readerPanelIsVisible(
  available: boolean,
  mode: ReaderPanelMode,
  transientOpen: boolean
): boolean {
  if (!available) return false;
  return mode === "pinned" || transientOpen;
}
