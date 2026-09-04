export interface HighlightDeletionTarget {
  id: string;
  bookTitle: string;
}

type HighlightDeletionDependencies<T> = {
  emitMirror: (type: string, data: Record<string, unknown>) => Promise<void>;
  beforeLocalCommit?: () => Promise<void>;
  commitLocal: (ids: string[]) => Promise<T>;
};

/**
 * Confirm every server-side deletion before committing one local transaction.
 * Duplicate IDs are collapsed so callers cannot emit the same logical delete
 * twice during one operation.
 */
export async function deleteHighlightsWithMirror<T>(
  targets: readonly HighlightDeletionTarget[],
  dependencies: HighlightDeletionDependencies<T>
): Promise<T> {
  const uniqueTargets = [
    ...new Map(targets.map(target => [target.id, target])).values(),
  ];
  for (const target of uniqueTargets) {
    await dependencies.emitMirror("highlight.deleted", {
      extId: target.id,
      bookTitle: target.bookTitle,
    });
  }
  await dependencies.beforeLocalCommit?.();
  return dependencies.commitLocal(uniqueTargets.map(target => target.id));
}

export function deleteHighlightWithMirror<T>(
  id: string,
  bookTitle: string,
  dependencies: HighlightDeletionDependencies<T>
): Promise<T> {
  return deleteHighlightsWithMirror([{ id, bookTitle }], dependencies);
}
