CREATE TABLE change_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1))
);
CREATE TABLE local_values (
  key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  value_json TEXT NOT NULL
);
