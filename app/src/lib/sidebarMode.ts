export type SidebarMode = "pinned" | "auto";

export const DEFAULT_SIDEBAR_MODE: SidebarMode = "pinned";
export const SIDEBAR_MODE_STORAGE_KEY = "shufang-sidebar-mode-v1";

interface SidebarModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isSidebarMode(value: unknown): value is SidebarMode {
  return value === "pinned" || value === "auto";
}

export function parseSidebarMode(value: string | null): SidebarMode {
  // `hidden` was supported by the first sidebar implementation. Treat it as
  // auto-hide so an existing preference can never leave the sidebar stranded.
  if (value === "hidden") return "auto";
  return isSidebarMode(value) ? value : DEFAULT_SIDEBAR_MODE;
}

export function toggleSidebarMode(mode: SidebarMode): SidebarMode {
  return mode === "pinned" ? "auto" : "pinned";
}

export function loadSidebarMode(
  storage: SidebarModeStorage | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage
): SidebarMode {
  if (!storage) return DEFAULT_SIDEBAR_MODE;
  try {
    return parseSidebarMode(storage.getItem(SIDEBAR_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_SIDEBAR_MODE;
  }
}

export function saveSidebarMode(
  mode: SidebarMode,
  storage: SidebarModeStorage | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable in private browsing or restricted webviews.
  }
}

export function sidebarOccupiesLayout(
  mode: SidebarMode,
  isMobile: boolean
): boolean {
  return mode === "pinned" && !isMobile;
}

export function sidebarIsVisible(
  mode: SidebarMode,
  transientOpen: boolean,
  mobileOpen: boolean,
  isMobile: boolean
): boolean {
  if (isMobile) return mobileOpen;
  return mode === "pinned" || transientOpen;
}
