import { sql } from "drizzle-orm";
import {
  mysqlTable,
  varchar,
  char,
  bigint,
  longtext,
  text,
  boolean,
  timestamp,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

const workspace = () => varchar("workspace", { length: 128 }).notNull();
export const syncHeads = mysqlTable("sync_heads", {
  workspace: workspace().primaryKey(),
  nodeId: varchar("node_id", { length: 128 }).notNull(),
  epoch: varchar("epoch", { length: 128 }).notNull(),
  seq: bigint("seq", { mode: "bigint", unsigned: true })
    .notNull()
    .default(sql`0`),
  clock: varchar("clock", { length: 40 }).notNull().default("0:0"),
});
export const syncOperations = mysqlTable(
  "sync_operations",
  {
    workspace: workspace(),
    operationId: varchar("operation_id", { length: 128 }).notNull(),
    seq: bigint("seq", { mode: "bigint", unsigned: true }).notNull(),
    digest: char("digest", { length: 64 }).notNull(),
    body: longtext("body").notNull(),
  },
  table => [
    primaryKey({ columns: [table.workspace, table.operationId] }),
    uniqueIndex("sync_sequence").on(table.workspace, table.seq),
  ]
);
export const syncEntities = mysqlTable(
  "sync_entities",
  {
    workspace: workspace(),
    kind: varchar("kind", { length: 32 }).notNull(),
    entityId: varchar("entity_id", { length: 128 }).notNull(),
    state: longtext("state").notNull(),
  },
  table => [
    primaryKey({ columns: [table.workspace, table.kind, table.entityId] }),
  ]
);
export const syncCursors = mysqlTable(
  "sync_cursors",
  {
    workspace: workspace(),
    peer: varchar("peer", { length: 128 }).notNull(),
    checkpoint: text("checkpoint").notNull(),
  },
  table => [primaryKey({ columns: [table.workspace, table.peer] })]
);
export const syncCredentials = mysqlTable(
  "sync_credentials",
  {
    workspace: workspace(),
    credentialId: varchar("credential_id", { length: 128 }).notNull(),
    digest: char("digest", { length: 64 }).notNull(),
    revoked: boolean("revoked").notNull().default(false),
  },
  table => [primaryKey({ columns: [table.workspace, table.credentialId] })]
);
export const syncSnapshots = mysqlTable("sync_snapshots", {
  id: varchar("id", { length: 128 }).primaryKey(),
  workspace: workspace(),
  checkpoint: text("checkpoint").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const syncSnapshotEntities = mysqlTable(
  "sync_snapshot_entities",
  {
    snapshotId: varchar("snapshot_id", { length: 128 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    entityId: varchar("entity_id", { length: 128 }).notNull(),
    state: longtext("state").notNull(),
  },
  table => [
    primaryKey({ columns: [table.snapshotId, table.kind, table.entityId] }),
  ]
);
