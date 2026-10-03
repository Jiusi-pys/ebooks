CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL
);
CREATE TABLE core_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE entities (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_json TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  operation_json TEXT NOT NULL
);
