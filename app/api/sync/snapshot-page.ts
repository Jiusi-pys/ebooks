/** Keep sync pages below the 16 MiB receiver limit, including JSON framing. */
export function boundedSnapshotEntities<T extends { kind: string; id: string }>(
  states: T[],
  cursor: string,
  maxBytes = 15 * 1024 * 1024
): { entities: T[]; next: string | null } {
  const entities: T[] = [];
  let next: string | null = null;
  for (const state of states) {
    const candidate = `${state.kind}:${state.id}`;
    const size = Buffer.byteLength(
      JSON.stringify({
        cursor,
        entities: [...entities, state],
        next: candidate,
      })
    );
    if (size > maxBytes) {
      if (!entities.length) throw new Error("snapshot_entity_too_large");
      break;
    }
    entities.push(state);
    next = candidate;
  }
  return { entities, next };
}
