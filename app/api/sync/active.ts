import type { SyncStore } from "./store";
import type { BlobStore } from "./blobs";
export let activeSyncStore: SyncStore | undefined;
export let activeSyncBlobs: BlobStore | undefined;
export function setActiveSyncStore(store: SyncStore, blobs?: BlobStore) {
  activeSyncStore = store;
  activeSyncBlobs = blobs;
}
