//! Native storage adapter. Schema receipts and all business writes are transactional.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use shufang_application::{Change, Commit, Repository, Result, StoredEntity};
use shufang_domain::sync::{compare_clock, EntityState, Operation};
use std::{cmp::Ordering, path::Path, time::Duration};
mod incoming_snapshot;
mod replica;
mod replication;

const MIGRATION: &str = include_str!("../migrations/0001.sql");
const MIGRATIONS: &[&str] = &[
    MIGRATION,
    include_str!("../migrations/0002.sql"),
    include_str!("../migrations/0003.sql"),
];
pub struct SqliteRepository {
    connection: Connection,
    workspace: String,
    replica: String,
}

fn failure(error: impl std::fmt::Display) -> String {
    format!("storage_error: {error}")
}

impl SqliteRepository {
    pub fn read_version(source: &Path) -> Result<u32> {
        let connection =
            Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(failure)?;
        connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(failure)
    }
    pub fn snapshot(source: &Path, destination: &Path) -> Result<()> {
        if destination.exists() {
            return Err("backup_destination_exists".into());
        }
        let source =
            Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(failure)?;
        source
            .busy_timeout(Duration::from_secs(5))
            .map_err(failure)?;
        source.backup("main", destination, None).map_err(failure)
    }
    pub fn open(path: &Path, workspace: &str, replica: &str) -> Result<Self> {
        if !shufang_domain::sync::valid_identifier(workspace)
            || !shufang_domain::sync::valid_identifier(replica)
        {
            return Err("invalid_identity".into());
        }
        let mut connection = Connection::open(path).map_err(failure)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(failure)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(failure)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(failure)?;
        if version < 0 || version > MIGRATIONS.len() as i64 {
            return Err("unsupported_database_version".into());
        }
        if version == 0 {
            let tables: i64 = tx.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |r|r.get(0)).map_err(failure)?;
            if tables != 0 {
                return Err("unrecognized_database".into());
            }
        }
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            let number = index as i64 + 1;
            let checksum = format!("{:x}", Sha256::digest(migration.as_bytes()));
            if number <= version {
                let receipt: String = tx
                    .query_row(
                        "SELECT sha256 FROM schema_migrations WHERE version=?",
                        [number],
                        |r| r.get(0),
                    )
                    .map_err(failure)?;
                if receipt != checksum {
                    return Err("migration_checksum_mismatch".into());
                }
            }
        }
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let number = index as i64 + 1;
            tx.execute_batch(migration).map_err(failure)?;
            let checksum = format!("{:x}", Sha256::digest(migration.as_bytes()));
            tx.execute(
                "INSERT INTO schema_migrations VALUES (?, ?)",
                params![number, checksum],
            )
            .map_err(failure)?;
            if number == 1 {
                for (key, value) in [
                    ("workspace", workspace),
                    ("replica", replica),
                    ("clock", "0:0"),
                ] {
                    tx.execute("INSERT INTO core_meta VALUES (?,?)", params![key, value])
                        .map_err(failure)?;
                }
            }
            tx.pragma_update(None, "user_version", number)
                .map_err(failure)?;
        }
        for (key, value) in [("workspace", workspace), ("replica", replica)] {
            let actual: String = tx
                .query_row("SELECT value FROM core_meta WHERE key=?", [key], |r| {
                    r.get(0)
                })
                .map_err(failure)?;
            if actual != value {
                return Err(format!("{key}_identity_mismatch"));
            }
        }
        tx.commit().map_err(failure)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(failure)?;
        Ok(Self {
            connection,
            workspace: workspace.into(),
            replica: replica.into(),
        })
    }
}

impl Repository for SqliteRepository {
    fn load(&self, kind: &str, id: &str) -> Result<Option<StoredEntity>> {
        let row: Option<(u64, String)> = self
            .connection
            .query_row(
                "SELECT revision,state_json FROM entities WHERE kind=? AND id=?",
                params![kind, id],
                |r| Ok((read_revision(r)?, r.get(1)?)),
            )
            .optional()
            .map_err(failure)?;
        row.map(|(revision, json)| {
            Ok(StoredEntity {
                revision,
                state: serde_json::from_str(&json).map_err(failure)?,
            })
        })
        .transpose()
    }
    fn list(&self, kind: &str) -> Result<Vec<StoredEntity>> {
        let mut query = self
            .connection
            .prepare("SELECT revision,state_json FROM entities WHERE kind=? ORDER BY id")
            .map_err(failure)?;
        let rows = query
            .query_map([kind], |r| Ok((read_revision(r)?, r.get::<_, String>(1)?)))
            .map_err(failure)?;
        rows.map(|r| {
            let (revision, json) = r.map_err(failure)?;
            Ok(StoredEntity {
                revision,
                state: serde_json::from_str(&json).map_err(failure)?,
            })
        })
        .collect()
    }
    fn clock(&self) -> Result<String> {
        self.connection
            .query_row("SELECT value FROM core_meta WHERE key='clock'", [], |r| {
                r.get(0)
            })
            .map_err(failure)
    }
    fn commit(&mut self, expected: u64, state: &EntityState, op: &Operation) -> Result<()> {
        self.commit_batch(
            &self.clock()?,
            &[Commit {
                expected,
                state: state.clone(),
                operation: op.clone(),
            }],
        )
    }
    fn commit_batch(&mut self, expected_clock: &str, commits: &[Commit]) -> Result<()> {
        self.commit_batch_local(expected_clock, commits, &[])
    }
    fn commit_batch_local(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
        locals: &[shufang_application::LocalCommit],
    ) -> Result<()> {
        self.commit_local_batch(expected_clock, commits, locals, false)
    }
    fn changes(&self, after: u64, limit: u32) -> Result<Vec<Change>> {
        let mut query = self.connection.prepare("SELECT sequence,kind,entity_id,revision,deleted FROM change_log WHERE sequence>? ORDER BY sequence LIMIT ?").map_err(failure)?;
        let rows = query
            .query_map(
                params![i64::try_from(after).map_err(failure)?, limit.clamp(1, 1000)],
                |r| {
                    Ok(Change {
                        sequence: read_u64(r, 0)?,
                        kind: r.get(1)?,
                        id: r.get(2)?,
                        revision: read_u64(r, 3)?,
                        deleted: r.get(4)?,
                        snapshot: None,
                    })
                },
            )
            .map_err(failure)?;
        rows.map(|r| {
            let mut change = r.map_err(failure)?;
            change.snapshot = self
                .get_local(&format!("journal:{}", change.sequence))?
                .map(|(_, value)| value);
            Ok(change)
        })
        .collect()
    }
    fn get_local(&self, key: &str) -> Result<Option<(u64, serde_json::Value)>> {
        let row: Option<(u64, String)> = self
            .connection
            .query_row(
                "SELECT revision,value_json FROM local_values WHERE key=?",
                [key],
                |r| Ok((read_revision(r)?, r.get(1)?)),
            )
            .optional()
            .map_err(failure)?;
        row.map(|(revision, value)| Ok((revision, serde_json::from_str(&value).map_err(failure)?)))
            .transpose()
    }
    fn local_usage(&self, prefix: &str) -> Result<(u64, u64)> {
        self.connection.query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(value_json AS BLOB))),0) FROM local_values WHERE substr(key,1,length(?1))=?1",[prefix],|r|Ok((read_u64(r,0)?,read_u64(r,1)?))).map_err(failure)
    }
    fn delete_expired_local(&mut self, prefix: &str, now: u64, limit: u32) -> Result<u64> {
        let count=self.connection.execute("DELETE FROM local_values WHERE key IN (SELECT key FROM local_values WHERE substr(key,1,length(?1))=?1 AND json_type(value_json,'$.expires')='integer' AND json_extract(value_json,'$.expires')<?2 LIMIT ?3)",params![prefix,i64::try_from(now).map_err(failure)?,limit.min(1000)]).map_err(failure)?;
        Ok(count as u64)
    }
    fn set_local(&mut self, key: &str, expected: u64, value: &serde_json::Value) -> Result<u64> {
        if key.is_empty() || key.len() > 256 {
            return Err("invalid_local_key".into());
        }
        let next = expected.checked_add(1).ok_or("revision_overflow")?;
        let next_sql = i64::try_from(next).map_err(failure)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let current: Option<u64> = tx
            .query_row(
                "SELECT revision FROM local_values WHERE key=?",
                [key],
                read_revision,
            )
            .optional()
            .map_err(failure)?;
        if current.unwrap_or(0) != expected {
            return Err("revision_conflict".into());
        }
        tx.execute("INSERT INTO local_values VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json", params![key,next_sql,serde_json::to_string(value).map_err(failure)?]).map_err(failure)?;
        tx.commit().map_err(failure)?;
        Ok(next)
    }
    fn pending(&self) -> Result<Vec<Operation>> {
        let mut query = self
            .connection
            .prepare("SELECT operation_json FROM outbox ORDER BY sequence")
            .map_err(failure)?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(failure)?;
        rows.map(|r| serde_json::from_str(&r.map_err(failure)?).map_err(failure))
            .collect()
    }
}

impl SqliteRepository {
    fn commit_local_batch(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
        locals: &[shufang_application::LocalCommit],
        shared_clock: bool,
    ) -> Result<()> {
        if (commits.is_empty() && locals.is_empty()) || commits.len() > 10_000 || locals.len() > 100
        {
            return Err("invalid_batch".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let mut clock: String = tx
            .query_row("SELECT value FROM core_meta WHERE key='clock'", [], |r| {
                r.get(0)
            })
            .map_err(failure)?;
        if clock != expected_clock {
            return Err("clock_conflict".into());
        }
        for commit in commits {
            let Commit {
                expected,
                state,
                operation: op,
            } = commit;
            if op.workspace_id != self.workspace || op.replica_id != self.replica {
                return Err("identity_mismatch".into());
            }
            shufang_domain::sync::validate_operation(op)?;
            let row: Option<(u64, String)> = tx
                .query_row(
                    "SELECT revision,state_json FROM entities WHERE kind=? AND id=?",
                    params![state.kind, state.id],
                    |r| Ok((read_revision(r)?, r.get(1)?)),
                )
                .optional()
                .map_err(failure)?;
            if row.as_ref().map_or(0, |r| r.0) != *expected {
                return Err("revision_conflict".into());
            }
            let prior: Option<EntityState> = row
                .map(|r| serde_json::from_str(&r.1))
                .transpose()
                .map_err(failure)?;
            if shufang_domain::sync::apply_operation(prior.as_ref(), op)? != *state {
                return Err("operation_state_mismatch".into());
            }
            if !shared_clock && compare_clock(&op.clock, &clock)? != Ordering::Greater {
                return Err("clock_conflict".into());
            }
            tx.execute("INSERT INTO entities VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json",
            params![state.kind,state.id,i64::try_from(expected.checked_add(1).ok_or("revision_overflow")?).map_err(failure)?,serde_json::to_string(state).map_err(failure)?]).map_err(failure)?;
            tx.execute(
                "INSERT INTO outbox(operation_id,operation_json) VALUES (?,?)",
                params![op.operation_id, serde_json::to_string(op).map_err(failure)?],
            )
            .map_err(failure)?;
            tx.execute(
                "INSERT INTO change_log(kind,entity_id,revision,deleted) VALUES (?,?,?,?)",
                params![
                    state.kind,
                    state.id,
                    i64::try_from(expected + 1).map_err(failure)?,
                    state.deleted
                ],
            )
            .map_err(failure)?;
            let value = if state.deleted {
                prior
                    .as_ref()
                    .map(shufang_domain::sync::materialize)
                    .transpose()?
                    .flatten()
            } else {
                shufang_domain::sync::materialize(state)?
            };
            if let Some(value) = value {
                let mut related = serde_json::Map::new();
                for (kind, field) in [("books", "bookId"), ("folders", "folderId")] {
                    let mut records = Vec::new();
                    if let Some(id) = value[field].as_str() {
                        let row: Option<(u64, String)> = tx
                            .query_row(
                                "SELECT revision,state_json FROM entities WHERE kind=? AND id=?",
                                params![kind, id],
                                |r| Ok((read_revision(r)?, r.get(1)?)),
                            )
                            .optional()
                            .map_err(failure)?;
                        if let Some((revision, raw)) = row {
                            let entity: EntityState =
                                serde_json::from_str(&raw).map_err(failure)?;
                            if let Some(value) = shufang_domain::sync::materialize(&entity)? {
                                records
                                    .push(serde_json::json!({"revision":revision,"value":value}));
                            }
                        }
                    }
                    related.insert(kind.into(), records.into());
                }
                let snapshot = serde_json::json!({"version":1,"record":{"revision":expected+1,"value":value},"related":related});
                let sequence = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO local_values VALUES (?,1,?)",
                    params![
                        format!("journal:{sequence}"),
                        serde_json::to_string(&snapshot).map_err(failure)?
                    ],
                )
                .map_err(failure)?;
            }
            if compare_clock(&op.clock, &clock)? == Ordering::Greater {
                clock = op.clock.clone();
            }
        }
        tx.execute("UPDATE core_meta SET value=? WHERE key='clock'", [&clock])
            .map_err(failure)?;
        let mut keys = std::collections::BTreeSet::new();
        for local in locals {
            if local.key.is_empty() || local.key.len() > 256 || !keys.insert(&local.key) {
                return Err("invalid_local_key".into());
            }
            let revision: Option<u64> = tx
                .query_row(
                    "SELECT revision FROM local_values WHERE key=?",
                    [&local.key],
                    read_revision,
                )
                .optional()
                .map_err(failure)?;
            if revision.unwrap_or(0) != local.expected {
                return Err("revision_conflict".into());
            }
            let next = local.expected.checked_add(1).ok_or("revision_overflow")?;
            tx.execute("INSERT INTO local_values VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json",params![local.key,i64::try_from(next).map_err(failure)?,serde_json::to_string(&local.value).map_err(failure)?]).map_err(failure)?;
        }
        tx.commit().map_err(failure)
    }
}

fn read_revision(row: &rusqlite::Row) -> rusqlite::Result<u64> {
    read_u64(row, 0)
}

fn read_u64(row: &rusqlite::Row, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
