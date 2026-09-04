export interface CachedDigest {
  contentHash: string;
  title: string;
  author: string;
  structure: string;
  overview: string | null;
}

/** Fallback cache used only when MySQL is absent or temporarily unavailable. */
const memoryDigests = new Map<string, CachedDigest>();

export function getMemoryDigest(contentHash: string): CachedDigest | null {
  return memoryDigests.get(contentHash) ?? null;
}

export function setMemoryDigest(digest: CachedDigest): void {
  memoryDigests.set(digest.contentHash, digest);
}

export function deleteMemoryDigest(contentHash: string): void {
  memoryDigests.delete(contentHash);
}
