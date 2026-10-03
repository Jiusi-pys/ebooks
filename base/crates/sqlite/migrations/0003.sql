-- Keep outbox as the immutable, ordered replication log, including remote ops.
INSERT INTO core_meta(key,value) VALUES('sync_epoch',lower(hex(randomblob(16))));
CREATE TABLE sync_snapshots (
  id TEXT PRIMARY KEY,
  checkpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sync_snapshot_entities (
  snapshot_id TEXT NOT NULL REFERENCES sync_snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,kind,entity_id)
);
