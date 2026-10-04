import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import { boundedSnapshotEntities } from "./snapshot-page";
import {
  applyOperation,
  materialize,
  compareClock,
  operationSchema,
  stableJson,
  validatePatch,
  type EntityState,
  type Operation,
} from "../../contracts/sync";

export class SyncError extends Error {
  constructor(
    public code: string,
    public status = 400
  ) {
    super(code);
  }
}
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type DB = Pool | PoolConnection;
async function rows(db: DB, sql: string, values: unknown[] = []) {
  const [result] = await db.query<RowDataPacket[]>(sql, values);
  return result;
}

export class SyncStore {
  pool: Pool;
  constructor(
    public databaseUrl: string,
    public workspace: string,
    public nodeId: string
  ) {
    this.pool = mysql.createPool({
      uri: databaseUrl,
      connectionLimit: 3,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  }
  async initialize() {
    const ddl = await readFile(
      resolve("db/migrations/0014_workspace_sync.sql"),
      "utf8"
    );
    for (const sql of ddl.split("--> statement-breakpoint"))
      if (sql.trim()) await this.pool.query(sql);
    await this.pool.query(
      "INSERT IGNORE INTO sync_heads (workspace,node_id,epoch) VALUES (?,?,?)",
      [this.workspace, this.nodeId, randomUUID()]
    );
    const head = (
      await rows(this.pool, "SELECT * FROM sync_heads WHERE workspace=?", [
        this.workspace,
      ])
    )[0];
    if (head.node_id !== this.nodeId)
      throw new SyncError("node_identity_mismatch", 409);
  }
  async close() {
    await this.pool.end();
  }
  async transaction<T>(fn: (db: PoolConnection) => Promise<T>) {
    const db = await this.pool.getConnection();
    try {
      await db.beginTransaction();
      const result = await fn(db);
      await db.commit();
      return result;
    } catch (error) {
      await db.rollback();
      throw error;
    } finally {
      db.release();
    }
  }
  async accept(input: unknown, transactionDb?: PoolConnection) {
    const op = operationSchema.parse(input);
    validatePatch(op);
    if (
      op.kind === "reviews" &&
      (op.entityId !== op.operationId || op.deleted || op.unset.length)
    )
      throw new SyncError("immutable_review_requires_unique_event_id", 409);
    if (op.workspaceId !== this.workspace)
      throw new SyncError("workspace_mismatch", 403);
    // JSON.stringify already formats primitive values; canonical key ordering
    // changes no bytes in the size. Reject before copying an oversized request
    // through the bounded WASM ABI.
    if (Buffer.byteLength(JSON.stringify(op)) > 1024 * 1024)
      throw new SyncError("operation_too_large", 413);
    const persist = async (db: PoolConnection) => {
      const head = (
        await rows(
          db,
          "SELECT * FROM sync_heads WHERE workspace=? FOR UPDATE",
          [this.workspace]
        )
      )[0];
      const hash = digest(stableJson(op));
      const old = (
        await rows(
          db,
          "SELECT seq,digest FROM sync_operations WHERE workspace=? AND operation_id=?",
          [this.workspace, op.operationId]
        )
      )[0];
      if (old) {
        if (old.digest !== hash)
          throw new SyncError("operation_id_reused", 409);
        return {
          operationId: op.operationId,
          seq: String(old.seq),
          duplicate: true,
        };
      }
      const stored = op;
      const current = (
        await rows(
          db,
          "SELECT state FROM sync_entities WHERE workspace=? AND kind=? AND entity_id=?",
          [this.workspace, op.kind, op.entityId]
        )
      )[0];
      const state = applyOperation(
        current ? JSON.parse(current.state) : undefined,
        stored
      );
      const seq = (BigInt(head.seq) + 1n).toString();
      await db.query(
        "INSERT INTO sync_operations (workspace,operation_id,seq,digest,body) VALUES (?,?,?,?,?)",
        [this.workspace, op.operationId, seq, hash, stableJson(stored)]
      );
      await db.query(
        "INSERT INTO sync_entities VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state)",
        [this.workspace, op.kind, op.entityId, JSON.stringify(state)]
      );
      const clock =
        compareClock(stored.clock, head.clock) > 0 ? stored.clock : head.clock;
      await db.query("UPDATE sync_heads SET seq=?,clock=? WHERE workspace=?", [
        seq,
        clock,
        this.workspace,
      ]);
      return { operationId: op.operationId, seq, duplicate: false };
    };
    return transactionDb ? persist(transactionDb) : this.transaction(persist);
  }
  async mutate(op: Operation) {
    if (!op.deleted) return this.accept(op);
    return this.transaction(async db => {
      const receipt = await this.accept(op, db);
      if (receipt.duplicate) return receipt;
      const all = await rows(
        db,
        "SELECT state FROM sync_entities WHERE workspace=?",
        [this.workspace]
      );
      for (const row of all) {
        const state: EntityState = JSON.parse(row.state);
        const data = materialize(state);
        if (!data || (state.kind === op.kind && state.id === op.entityId))
          continue;
        let deleted = false;
        const unset: string[] = [];
        if (op.kind === "books") {
          deleted =
            ["highlights", "translations", "mindMaps"].includes(state.kind) &&
            data.bookId === op.entityId;
          if (state.kind === "sources" && state.id === op.entityId)
            deleted = true;
          if (
            state.kind === "associations" &&
            [data.source, data.target].some(
              anchor =>
                (anchor as { bookId?: string } | undefined)?.bookId ===
                op.entityId
            )
          )
            deleted = true;
          if (
            state.kind === "studySets" &&
            state.fields[`@member:${op.entityId}`]
          )
            unset.push(`@member:${op.entityId}`);
        }
        if (
          op.kind === "folders" &&
          state.kind === "books" &&
          data.folderId === op.entityId
        )
          unset.push("folderId");
        if (
          op.kind === "notes" &&
          state.kind === "highlights" &&
          data.noteId === op.entityId
        )
          unset.push("noteId");
        if (!deleted && !unset.length) continue;
        const child: Operation = {
          ...op,
          kind: state.kind,
          entityId: state.id,
          operationId: `cascade-${digest(op.operationId + state.kind + state.id)}`,
          patch: {},
          unset,
          deleted,
        };
        await this.accept(child, db);
      }
      return receipt;
    });
  }
  async head() {
    return (
      await rows(this.pool, "SELECT * FROM sync_heads WHERE workspace=?", [
        this.workspace,
      ])
    )[0];
  }
  async entity(kind: string, id: string): Promise<EntityState | undefined> {
    const row = (
      await rows(
        this.pool,
        "SELECT state FROM sync_entities WHERE workspace=? AND kind=? AND entity_id=?",
        [this.workspace, kind, id]
      )
    )[0];
    return row ? JSON.parse(row.state) : undefined;
  }
  async operation(id: string): Promise<Operation | undefined> {
    const row = (
      await rows(
        this.pool,
        "SELECT body FROM sync_operations WHERE workspace=? AND operation_id=?",
        [this.workspace, id]
      )
    )[0];
    return row ? JSON.parse(row.body) : undefined;
  }
  cursor(epoch: string, seq: string) {
    return Buffer.from(
      JSON.stringify({
        workspace: this.workspace,
        node: this.nodeId,
        epoch,
        seq,
      })
    ).toString("base64url");
  }
  async changes(cursor?: string, limit = 100) {
    const head = await this.head();
    let seq = "0";
    if (cursor) {
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
      } catch {
        throw new SyncError("invalid_cursor");
      }
      if (
        !decoded ||
        typeof decoded !== "object" ||
        typeof decoded.seq !== "string" ||
        decoded.seq.length > 20
      )
        throw new SyncError("invalid_cursor");
      if (
        decoded.workspace !== this.workspace ||
        decoded.node !== this.nodeId ||
        decoded.epoch !== head.epoch
      )
        throw new SyncError("cursor_scope_mismatch", 409);
      if (!/^\d+$/.test(decoded.seq) || BigInt(decoded.seq) > BigInt(head.seq))
        throw new SyncError("invalid_cursor");
      seq = decoded.seq;
    }
    const result = await rows(
      this.pool,
      "SELECT seq,body FROM sync_operations WHERE workspace=? AND seq>? ORDER BY seq LIMIT ?",
      [this.workspace, seq, Math.min(100, Math.max(1, limit))]
    );
    const accepted: Operation[] = [];
    let bytes = 0;
    for (const row of result) {
      const size = Buffer.byteLength(row.body);
      if (accepted.length && bytes + size > 1024 * 1024) break;
      accepted.push(JSON.parse(row.body));
      bytes += size;
      seq = String(row.seq);
    }
    return {
      operations: accepted,
      cursor: this.cursor(head.epoch, seq),
      hasMore: BigInt(seq) < BigInt(head.seq),
    };
  }
  async entities(kind?: string, after = "", limit = 100) {
    const result = await rows(
      this.pool,
      "SELECT kind,entity_id,state FROM sync_entities WHERE workspace=? AND CONCAT(kind,':',entity_id)>?" +
        (kind ? " AND kind=?" : "") +
        " ORDER BY kind,entity_id LIMIT ?",
      [
        this.workspace,
        after,
        ...(kind ? [kind] : []),
        Math.min(100, Math.max(1, limit)),
      ]
    );
    return {
      entities: result.map(row => JSON.parse(row.state) as EntityState),
      next: result.length
        ? `${result.at(-1)!.kind}:${result.at(-1)!.entity_id}`
        : null,
    };
  }
  async snapshot() {
    return this.transaction(async db => {
      const head = (
        await rows(
          db,
          "SELECT * FROM sync_heads WHERE workspace=? FOR UPDATE",
          [this.workspace]
        )
      )[0];
      const id = randomUUID();
      const cursor = this.cursor(head.epoch, String(head.seq));
      await db.query(
        "DELETE e FROM sync_snapshot_entities e JOIN sync_snapshots s ON s.id=e.snapshot_id WHERE s.workspace=? AND s.id NOT LIKE 'version-%' AND s.created_at < NOW() - INTERVAL 1 DAY",
        [this.workspace]
      );
      await db.query(
        "DELETE FROM sync_snapshots WHERE workspace=? AND id NOT LIKE 'version-%' AND created_at < NOW() - INTERVAL 1 DAY",
        [this.workspace]
      );
      await db.query(
        "INSERT INTO sync_snapshots(id,workspace,checkpoint) VALUES (?,?,?)",
        [id, this.workspace, cursor]
      );
      await db.query(
        "INSERT INTO sync_snapshot_entities SELECT ?,kind,entity_id,state FROM sync_entities WHERE workspace=?",
        [id, this.workspace]
      );
      return { id, cursor };
    });
  }
  async snapshotPage(id: string, after = "") {
    const snap = (
      await rows(
        this.pool,
        "SELECT checkpoint FROM sync_snapshots WHERE id=? AND workspace=?",
        [id, this.workspace]
      )
    )[0];
    if (!snap) throw new SyncError("snapshot_not_found", 404);
    const result = await rows(
      this.pool,
      "SELECT kind,entity_id,state FROM sync_snapshot_entities WHERE snapshot_id=? AND CONCAT(kind,':',entity_id)>? ORDER BY kind,entity_id LIMIT 100",
      [id, after]
    );
    try {
      return {
        cursor: snap.checkpoint,
        ...boundedSnapshotEntities(
          result.map(row => JSON.parse(row.state) as EntityState),
          snap.checkpoint
        ),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "snapshot_entity_too_large"
      )
        throw new SyncError("snapshot_entity_too_large", 413);
      throw error;
    }
  }
  async history(kind: string, id: string) {
    return (
      await rows(
        this.pool,
        "SELECT body FROM sync_operations WHERE workspace=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.kind'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.entityId'))=? ORDER BY seq DESC LIMIT 100",
        [this.workspace, kind, id]
      )
    ).map(row => JSON.parse(row.body));
  }
  async peerCursor(peer: string) {
    return (
      await rows(
        this.pool,
        "SELECT checkpoint FROM sync_cursors WHERE workspace=? AND peer=?",
        [this.workspace, peer]
      )
    )[0]?.checkpoint as string | undefined;
  }
  async savePeerCursor(peer: string, cursor: string) {
    await this.pool.query(
      "INSERT INTO sync_cursors VALUES (?,?,?) ON DUPLICATE KEY UPDATE checkpoint=VALUES(checkpoint)",
      [this.workspace, peer, cursor]
    );
  }
  async credential(id: string, token: string) {
    await this.pool.query(
      "INSERT INTO sync_credentials VALUES (?,?,?,FALSE) ON DUPLICATE KEY UPDATE digest=VALUES(digest),revoked=FALSE",
      [this.workspace, id, digest(token)]
    );
  }
  async authorized(token: string) {
    return (
      (
        await rows(
          this.pool,
          "SELECT credential_id FROM sync_credentials WHERE workspace=? AND digest=? AND revoked=FALSE",
          [this.workspace, digest(token)]
        )
      ).length > 0
    );
  }
  async revoke(id: string) {
    await this.pool.query(
      "UPDATE sync_credentials SET revoked=TRUE WHERE workspace=? AND credential_id=?",
      [this.workspace, id]
    );
  }
}
