import { syncDatabase } from "./db";
import { trackDatabase } from "./syncDatabase";

// Explicit allowlist: credentials, sessions and AI API keys never enter this path.
export const preferenceKeys = [
  "shufang-sidebar-mode-v1",
  "shufang-reader-right-panel-mode-v1",
  "shufang-reader-right-panel-content-mode-v1",
  "shufang-type2",
  "shufang:search-engine",
];
export function persistPreference(
  key: string,
  value: string,
  storage: unknown
) {
  if (
    typeof localStorage === "undefined" ||
    storage !== localStorage ||
    !preferenceKeys.includes(key)
  )
    return;
  void syncDatabase()
    .then(db => trackDatabase(db).put("preferences", { id: key, value }))
    .catch(error => {
      console.error("Preference persistence failed", error);
      window.dispatchEvent(
        new CustomEvent("shufang:sync-error", {
          detail: "偏好设置待同步记录保存失败",
        })
      );
    });
}
export async function applyPreferences() {
  const db = await syncDatabase();
  let changed = false;
  for (const row of await db.getAll("preferences")) {
    if (!preferenceKeys.includes(row.id) || typeof row.value !== "string")
      continue;
    if (localStorage.getItem(row.id) !== row.value) {
      localStorage.setItem(row.id, row.value);
      changed = true;
    }
  }
  if (changed) {
    window.dispatchEvent(new Event("storage"));
    window.dispatchEvent(new Event("shufang:preferences-updated"));
  }
}
