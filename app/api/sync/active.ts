import type { SyncStore } from "./store";
export let activeSyncStore: SyncStore | undefined;
export function setActiveSyncStore(store: SyncStore) {
  activeSyncStore = store;
}
