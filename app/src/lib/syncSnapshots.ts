import type { IDBPDatabase } from "idb";
import { sharedCore } from "@contracts/core-runtime";
import {
  entityKinds,
  materialize,
  projectable,
  compareClock,
  nextClock,
  type EntityState,
} from "@contracts/sync";
import { syncStores } from "./syncDatabase";

interface Download {
  id: string;
  version: 1;
  snapshotId: string;
  cursor: string;
  after: string | null;
  pages: number;
  expectedCursor: string | null;
}
export interface SnapshotPage {
  cursor: string;
  entities: EntityState[];
  next: string | null;
}
const metadataKey = (key: string) => `snapshot:${key}`;
const pageKey = (key: string, index: number) => `snapshot-page:${key}:${index}`;
function merge(
  prior: EntityState | undefined,
  incoming: EntityState
): EntityState {
  return JSON.parse(
    sharedCore().execute<string>("mergeReplicaStates", {
      priorJson: prior ? JSON.stringify(prior) : null,
      incomingJson: JSON.stringify(incoming),
    })
  ) as EntityState;
}
export async function abandonSnapshot(db: IDBPDatabase, key: string) {
  const tx = db.transaction("syncMeta", "readwrite");
  const checkpoint = (await tx.store.get(metadataKey(key))) as
    Download | undefined;
  for (let index = 0; index < (checkpoint?.pages ?? 0); index++)
    await tx.store.delete(pageKey(key, index));
  await tx.store.delete(metadataKey(key));
  await tx.done;
}
export async function beginSnapshot(
  db: IDBPDatabase,
  key: string,
  snapshot: { id: string; cursor: string }
) {
  if (
    !/^[\w.:-]{1,128}$/.test(snapshot.id) ||
    typeof snapshot.cursor !== "string" ||
    !snapshot.cursor ||
    snapshot.cursor.length > 4096
  )
    throw new Error("invalid_snapshot");
  const tx = db.transaction("syncMeta", "readwrite");
  if (await tx.store.get(metadataKey(key))) {
    await tx.done;
    throw new Error("snapshot_in_progress");
  }
  await tx.store.put({
    id: metadataKey(key),
    version: 1,
    snapshotId: snapshot.id,
    cursor: snapshot.cursor,
    after: "",
    pages: 0,
    expectedCursor: (await tx.store.get(key))?.cursor ?? null,
  } satisfies Download);
  await tx.done;
}
export async function stageSnapshot(
  db: IDBPDatabase,
  key: string,
  page: SnapshotPage,
  expected: { after: string; pages: number }
) {
  if (
    !Array.isArray(page.entities) ||
    page.entities.length > 100 ||
    (page.next !== null &&
      (typeof page.next !== "string" || !page.next || page.next.length > 512))
  )
    throw new Error("invalid_snapshot_page");
  const seen = new Set<string>();
  for (const state of page.entities) {
    merge(undefined, state);
    const id = `${state.kind}:${state.id}`;
    if (seen.has(id)) throw new Error("duplicate_snapshot_entity");
    seen.add(id);
  }
  const tx = db.transaction("syncMeta", "readwrite");
  try {
    const checkpoint = (await tx.store.get(metadataKey(key))) as
      Download | undefined;
    if (
      checkpoint?.version !== 1 ||
      checkpoint.after !== expected.after ||
      checkpoint.pages !== expected.pages ||
      checkpoint.after === null ||
      page.cursor !== checkpoint.cursor ||
      page.next === checkpoint.after ||
      checkpoint.pages >= 100000
    )
      throw new Error("snapshot_page_mismatch");
    await tx.store.put({
      id: pageKey(key, checkpoint.pages),
      entities: page.entities,
    });
    checkpoint.pages++;
    checkpoint.after = page.next;
    await tx.store.put(checkpoint);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* already aborted */
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}
export async function finishSnapshot(
  db: IDBPDatabase,
  key: string,
  now: number
) {
  const names = [
    ...entityKinds.filter(k => db.objectStoreNames.contains(k)),
    ...syncStores,
    ...(db.objectStoreNames.contains("files") ? ["files"] : []),
  ];
  const tx = db.transaction(names, "readwrite");
  try {
    const meta = tx.objectStore("syncMeta");
    const checkpoint = (await meta.get(metadataKey(key))) as
      Download | undefined;
    if (
      checkpoint?.version !== 1 ||
      checkpoint.after !== null ||
      checkpoint.pages < 1
    )
      throw new Error("snapshot_incomplete");
    if (
      !Object.prototype.hasOwnProperty.call(checkpoint, "expectedCursor") ||
      ((await meta.get(key))?.cursor ?? null) !== checkpoint.expectedCursor
    )
      throw new Error("snapshot_cursor_changed");
    const identity = await meta.get("identity");
    const seen = new Set<string>();
    for (let index = 0; index < checkpoint.pages; index++) {
      const page = await meta.get(pageKey(key, index));
      if (!page || !Array.isArray(page.entities))
        throw new Error("snapshot_page_missing");
      for (const incoming of page.entities as EntityState[]) {
        const id = `${incoming.kind}:${incoming.id}`;
        if (seen.has(id)) throw new Error("duplicate_snapshot_entity");
        seen.add(id);
        const prior = await tx.objectStore("syncEntities").get(id);
        const state = merge(prior?.state, incoming);
        await tx.objectStore("syncEntities").put({ id, state });
        if (
          state.kind === "sources" &&
          db.objectStoreNames.contains("files") &&
          (state.deleted ||
            prior?.state.fields.sha256?.value !== state.fields.sha256?.value) &&
          !(await meta.get(`file:${state.id}`))?.pending
        )
          await tx.objectStore("files").delete(state.id);
        if (db.objectStoreNames.contains(state.kind)) {
          const data = materialize(state);
          if (!data) await tx.objectStore(state.kind).delete(state.id);
          else if (projectable(state.kind, data))
            await tx.objectStore(state.kind).put(data);
        }
        for (const field of Object.values(state.fields)) {
          const [wall, count] = field.version.split(":");
          const clock = `${BigInt(wall)}:${BigInt(count)}`;
          if (identity && compareClock(clock, identity.clock) >= 0)
            identity.clock = nextClock(clock);
        }
      }
      await meta.delete(pageKey(key, index));
    }
    if (identity) await meta.put(identity);
    await meta.put({ id: key, cursor: checkpoint.cursor, snapshotAt: now });
    await meta.delete(metadataKey(key));
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* already aborted */
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}
