import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { sharedCore } from "../../contracts/core-runtime";
import {
  compareClock,
  nextClock,
  type EntityState,
} from "../../contracts/sync";
import { digest, SyncError, SyncStore } from "./store";

export interface IncomingSnapshot {
  version: 1;
  snapshotId: string;
  cursor: string;
  after: string | null;
  pages: number;
  expectedCursor: string | null;
}
const idFor = (workspace: string, key: string) =>
  `incoming:${digest(JSON.stringify([workspace, key]))}`;
const timeKey = (key: string) => `snapshot-at:${digest(key)}`;
async function rows(db: PoolConnection, query: string, values: unknown[]) {
  return (await db.query<RowDataPacket[]>(query, values))[0];
}
function merge(prior: string | null, incoming: string): EntityState {
  return JSON.parse(
    sharedCore().execute<string>("mergeReplicaStates", {
      priorJson: prior,
      incomingJson: incoming,
    })
  ) as EntityState;
}
export class IncomingSnapshots {
  constructor(private readonly store: SyncStore) {}
  async pending(key: string): Promise<IncomingSnapshot | undefined> {
    const [result] = await this.store.pool.query<RowDataPacket[]>(
      "SELECT checkpoint FROM sync_snapshots WHERE id=? AND workspace=?",
      [idFor(this.store.workspace, key), this.store.workspace]
    );
    if (!result.length) return;
    const metadata: IncomingSnapshot = JSON.parse(result[0].checkpoint);
    if (metadata.version !== 1)
      throw new SyncError("invalid_incoming_snapshot");
    return metadata;
  }
  async age(key: string) {
    return Number(await this.store.peerCursor(timeKey(key))) || 0;
  }
  async begin(
    key: string,
    remote: { id: string; cursor: string },
    now: number
  ) {
    if (
      !/^[\w.:-]{1,128}$/.test(remote.id) ||
      typeof remote.cursor !== "string" ||
      !remote.cursor ||
      remote.cursor.length > 4096
    )
      throw new SyncError("invalid_snapshot");
    await this.store.transaction(async db => {
      const expectedCursor =
        (
          await rows(
            db,
            "SELECT checkpoint FROM sync_cursors WHERE workspace=? AND peer=? FOR UPDATE",
            [this.store.workspace, key]
          )
        )[0]?.checkpoint ?? null;
      await db.query(
        "INSERT INTO sync_snapshots(id,workspace,checkpoint,created_at) VALUES (?,?,?,?)",
        [
          idFor(this.store.workspace, key),
          this.store.workspace,
          JSON.stringify({
            version: 1,
            snapshotId: remote.id,
            cursor: remote.cursor,
            after: "",
            pages: 0,
            expectedCursor,
          } satisfies IncomingSnapshot),
          new Date(now),
        ]
      );
    });
  }
  async stage(
    key: string,
    expected: { after: string; pages: number },
    page: { cursor: string; entities: unknown[]; next: string | null }
  ) {
    if (
      !Array.isArray(page.entities) ||
      page.entities.length > 100 ||
      (page.next !== null &&
        (typeof page.next !== "string" || !page.next || page.next.length > 512))
    )
      throw new SyncError("invalid_snapshot_page");
    const states = page.entities.map(state =>
      merge(null, JSON.stringify(state))
    );
    if (new Set(states.map(s => `${s.kind}:${s.id}`)).size !== states.length)
      throw new SyncError("duplicate_snapshot_entity");
    await this.store.transaction(async db => {
      const id = idFor(this.store.workspace, key);
      const checkpoint = (
        await rows(
          db,
          "SELECT checkpoint FROM sync_snapshots WHERE id=? AND workspace=? FOR UPDATE",
          [id, this.store.workspace]
        )
      )[0];
      const metadata: IncomingSnapshot | undefined =
        checkpoint && JSON.parse(checkpoint.checkpoint);
      if (
        metadata?.version !== 1 ||
        metadata.after !== expected.after ||
        metadata.pages !== expected.pages ||
        metadata.cursor !== page.cursor ||
        metadata.after === null ||
        metadata.after === page.next ||
        metadata.pages >= 100000
      )
        throw new SyncError("snapshot_page_mismatch");
      for (const state of states)
        await db.query("INSERT INTO sync_snapshot_entities VALUES (?,?,?,?)", [
          id,
          state.kind,
          state.id,
          JSON.stringify(state),
        ]);
      await db.query("UPDATE sync_snapshots SET checkpoint=? WHERE id=?", [
        JSON.stringify({
          ...metadata,
          pages: metadata.pages + 1,
          after: page.next,
        }),
        id,
      ]);
    });
  }
  async abandon(key: string) {
    await this.store.transaction(async db => {
      const id = idFor(this.store.workspace, key);
      await db.query("DELETE FROM sync_snapshot_entities WHERE snapshot_id=?", [
        id,
      ]);
      await db.query("DELETE FROM sync_snapshots WHERE id=? AND workspace=?", [
        id,
        this.store.workspace,
      ]);
    });
  }
  async finish(key: string, now: number) {
    await this.store.transaction(async db => {
      const head = (
        await rows(
          db,
          "SELECT clock FROM sync_heads WHERE workspace=? FOR UPDATE",
          [this.store.workspace]
        )
      )[0];
      if (!head) throw new SyncError("workspace_not_initialized");
      const id = idFor(this.store.workspace, key);
      const checkpoint = (
        await rows(
          db,
          "SELECT checkpoint FROM sync_snapshots WHERE id=? AND workspace=? FOR UPDATE",
          [id, this.store.workspace]
        )
      )[0];
      const metadata: IncomingSnapshot | undefined =
        checkpoint && JSON.parse(checkpoint.checkpoint);
      if (
        metadata?.version !== 1 ||
        metadata.after !== null ||
        metadata.pages < 1
      )
        throw new SyncError("snapshot_incomplete");
      const cursor =
        (
          await rows(
            db,
            "SELECT checkpoint FROM sync_cursors WHERE workspace=? AND peer=? FOR UPDATE",
            [this.store.workspace, key]
          )
        )[0]?.checkpoint ?? null;
      if (cursor !== metadata.expectedCursor)
        throw new SyncError("snapshot_cursor_conflict");
      let clock = String(head.clock);
      for (const row of await rows(
        db,
        "SELECT state FROM sync_snapshot_entities WHERE snapshot_id=? ORDER BY kind,entity_id",
        [id]
      )) {
        const incoming: EntityState = JSON.parse(row.state);
        const prior = (
          await rows(
            db,
            "SELECT state FROM sync_entities WHERE workspace=? AND kind=? AND entity_id=?",
            [this.store.workspace, incoming.kind, incoming.id]
          )
        )[0];
        const state = merge(prior?.state ?? null, row.state);
        await db.query(
          "INSERT INTO sync_entities VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state)",
          [this.store.workspace, state.kind, state.id, JSON.stringify(state)]
        );
        for (const field of Object.values(state.fields)) {
          const [wall, count] = field.version.split(":");
          const received = `${BigInt(wall)}:${BigInt(count)}`;
          if (compareClock(received, clock) >= 0) clock = nextClock(received);
        }
      }
      await db.query("UPDATE sync_heads SET clock=? WHERE workspace=?", [
        clock,
        this.store.workspace,
      ]);
      for (const [peer, value] of [
        [key, metadata.cursor],
        [timeKey(key), String(now)],
      ])
        await db.query(
          "INSERT INTO sync_cursors VALUES (?,?,?) ON DUPLICATE KEY UPDATE checkpoint=VALUES(checkpoint)",
          [this.store.workspace, peer, value]
        );
      await db.query("DELETE FROM sync_snapshot_entities WHERE snapshot_id=?", [
        id,
      ]);
      await db.query("DELETE FROM sync_snapshots WHERE id=?", [id]);
    });
  }
}
