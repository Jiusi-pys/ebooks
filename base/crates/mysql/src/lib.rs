//! MySQL adapter for the existing Node workspace-v2 ledger. No shadow SQLite DB.
use mysql::{
    prelude::Queryable, Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Transaction,
    TxOpts,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_application::{
    Change, Commit, LocalCommit, LogOperation, ReplicationHead, ReplicationRepository, Repository,
    Result, StoredEntity,
};
use shufang_domain::sync::{apply_operation, compare_clock, EntityState, Operation};
use std::cmp::Ordering;
pub mod backup;
mod incoming_snapshot;
pub mod migrations;

pub struct MysqlRepository {
    pool: Pool,
    workspace: String,
    node: String,
    read_only: bool,
    writer: Option<std::sync::Mutex<Conn>>,
    lock_name: String,
}
pub(crate) fn database_gate(db: &mut Conn) -> Result<()> {
    let database: String = db
        .query_first("SELECT DATABASE()")
        .map_err(failure)?
        .ok_or("invalid_database")?;
    let lock = format!("shufang-restore-{:x}", Sha256::digest(database.as_bytes()));
    let lock = &lock[..64];
    let acquired: Option<u8> = db
        .exec_first("SELECT GET_LOCK(?,0)", (lock,))
        .map_err(failure)?;
    if acquired != Some(1) {
        return Err("database_restore_or_open_running".into());
    }
    Ok(())
}
fn failure(_: impl std::fmt::Display) -> String {
    "storage_error: mysql operation failed".into()
}
fn parse<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T> {
    serde_json::from_str(raw).map_err(failure)
}
fn stringify<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(failure)
}
fn read_entity<Q: Queryable>(
    db: &mut Q,
    workspace: &str,
    kind: &str,
    id: &str,
) -> Result<Option<StoredEntity>> {
    let row:Option<(String,u64)>=db.exec_first("SELECT e.state,COALESCE(r.revision,1) FROM sync_entities e LEFT JOIN rust_entity_revisions r ON r.workspace=e.workspace AND r.kind=e.kind AND r.entity_id=e.entity_id WHERE e.workspace=? AND e.kind=? AND e.entity_id=?",(workspace,kind,id)).map_err(failure)?;
    row.map(|(raw, revision)| {
        Ok(StoredEntity {
            revision,
            state: parse(&raw)?,
        })
    })
    .transpose()
}
fn local<Q: Queryable>(db: &mut Q, workspace: &str, key: &str) -> Result<Option<(u64, Value)>> {
    let row: Option<(u64, String)> = db
        .exec_first(
            "SELECT revision,value_json FROM rust_local_values WHERE workspace=? AND local_key=?",
            (workspace, key),
        )
        .map_err(failure)?;
    row.map(|(revision, raw)| Ok((revision, parse(&raw)?)))
        .transpose()
}
fn digest_hash(key: &str) -> Result<Option<&str>> {
    let Some(hash) = key.strip_prefix("digest:") else {
        return Ok(None);
    };
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid_digest_hash".into());
    }
    Ok(Some(hash))
}
fn digest_referenced<Q: Queryable>(db: &mut Q, workspace: &str, hash: &str) -> Result<bool> {
    let rows: Vec<String> = db
        .exec(
            "SELECT state FROM sync_entities WHERE workspace=? AND kind='books' FOR UPDATE",
            (workspace,),
        )
        .map_err(failure)?;
    for raw in rows {
        let state: EntityState = parse(&raw)?;
        if shufang_domain::sync::materialize(&state)?.is_some_and(|v| v["contentHash"] == hash) {
            return Ok(true);
        }
    }
    Ok(false)
}
fn cleanup_digests<Q: Queryable>(
    db: &mut Q,
    workspace: &str,
    hashes: &std::collections::BTreeSet<String>,
) -> Result<()> {
    for hash in hashes {
        if !digest_referenced(db, workspace, hash)? {
            db.exec_drop("DELETE FROM book_digests WHERE content_hash=?", (hash,))
                .map_err(failure)?;
            db.exec_drop(
                "DELETE FROM rust_local_values WHERE workspace=? AND local_key=?",
                (workspace, format!("digest:{hash}")),
            )
            .map_err(failure)?;
        }
    }
    Ok(())
}
fn write_local<Q: Queryable>(db: &mut Q, workspace: &str, commit: &LocalCommit) -> Result<u64> {
    if commit.key.is_empty() || commit.key.len() > 256 {
        return Err("invalid_local_key".into());
    }
    if local(db, workspace, &commit.key)?.map_or(0, |v| v.0) != commit.expected {
        return Err("revision_conflict".into());
    }
    let revision = commit.expected.checked_add(1).ok_or("revision_overflow")?;
    if let Some(hash) = digest_hash(&commit.key)? {
        if commit.value["invalidated"] == true {
            if !digest_referenced(db, workspace, hash)? {
                db.exec_drop("DELETE FROM book_digests WHERE content_hash=?", (hash,))
                    .map_err(failure)?;
            }
        } else {
            if !digest_referenced(db, workspace, hash)? {
                return Err("digest_unreferenced".into());
            }
            let v = &commit.value;
            db.exec_drop("INSERT INTO book_digests(content_hash,title,author,structure,overview) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),author=VALUES(author),structure=VALUES(structure),overview=VALUES(overview)",(hash,v["title"].as_str().ok_or("invalid_digest")?,v["author"].as_str().unwrap_or(""),v["structure"].as_str().ok_or("invalid_digest")?,v["overview"].as_str())).map_err(failure)?;
        }
    }
    if commit.key == "sync:credentials" {
        let values = commit.value.as_object().ok_or("invalid_credentials")?;
        if values.len() > 100
            || values.iter().any(|(id, value)| {
                !shufang_domain::sync::valid_identifier(id)
                    || value.as_str().is_none_or(|s| {
                        s.len() != 64
                            || !s
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
            })
        {
            return Err("invalid_credentials".into());
        }
        db.exec_drop(
            "UPDATE sync_credentials SET revoked=1 WHERE workspace=?",
            (workspace,),
        )
        .map_err(failure)?;
        for (id, digest) in values {
            db.exec_drop("INSERT INTO sync_credentials(workspace,credential_id,digest,revoked) VALUES(?,?,?,0) ON DUPLICATE KEY UPDATE digest=VALUES(digest),revoked=0",(workspace,id,digest.as_str().ok_or("invalid_credentials")?)).map_err(failure)?;
        }
    }

    db.exec_drop("INSERT INTO rust_local_values(workspace,local_key,revision,value_json) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),value_json=VALUES(value_json)",(workspace,&commit.key,revision,stringify(&commit.value)?)).map_err(failure)?;
    Ok(revision)
}
impl MysqlRepository {
    pub fn legacy_webhooks(&self) -> Result<Vec<Value>> {
        type LegacyWebhookRow = (u64, String, String, String, bool, i32, String, u64);
        let rows:Vec<LegacyWebhookRow>=self.pool.get_conn().map_err(failure)?.query("SELECT id,url,secret,events,active,fail_count,description,CAST(UNIX_TIMESTAMP(created_at)*1000 AS UNSIGNED) FROM webhook_subscriptions ORDER BY id").map_err(failure)?;
        rows.into_iter().map(|(id,url,secret,events,active,fail_count,description,created_at)|Ok(json!({"id":id,"url":url,"secret":secret,"events":parse::<Value>(&events)?,"active":active,"failCount":fail_count,"description":description,"createdAt":created_at}))).collect()
    }
    pub fn legacy_upload(&self, book: &str, upload: &str) -> Result<Option<Value>> {
        let mut db = self.pool.get_conn().map_err(failure)?;
        let rows:Vec<(i32,String)>=db.exec("SELECT chunk_index,payload FROM mirror_book_upload_chunks WHERE book_ext_id=? AND upload_id=? ORDER BY chunk_index",(book,upload)).map_err(failure)?;
        let Some((_, raw)) = rows.iter().find(|(index, _)| *index == -1) else {
            return Ok(None);
        };
        let manifest: Value = parse(raw)?;
        let mut chunks = serde_json::Map::new();
        let mut bytes = 0u64;
        for (index, payload) in rows.iter().filter(|(index, _)| *index >= 0) {
            bytes = bytes
                .checked_add(payload.len() as u64)
                .ok_or("invalid_upload_size")?;
            chunks.insert(index.to_string(), json!(payload));
        }
        Ok(Some(
            json!({"version":1,"manifest":manifest,"chunks":chunks,"bytes":bytes,"limit":manifest["encodedBytes"],"expires":u64::MAX}),
        ))
    }
    pub fn open(url: &str, workspace: &str, node: &str, read_only: bool) -> Result<Self> {
        if !shufang_domain::sync::valid_identifier(workspace)
            || !shufang_domain::sync::valid_identifier(node)
        {
            return Err("invalid_identity".into());
        }
        let opts = Opts::from_url(url).map_err(|_| "invalid_database_url")?;
        let mut gate = Conn::new(opts.clone()).map_err(failure)?;
        database_gate(&mut gate)?;
        let opts = OptsBuilder::from_opts(opts).pool_opts(
            PoolOpts::default().with_constraints(PoolConstraints::new(0, 3).ok_or("invalid_pool")?),
        );
        let pool = Pool::new(opts.clone()).map_err(failure)?;
        let mut db = pool.get_conn().map_err(failure)?;
        // Migrations are executed by the versioned release migrator, not startup.
        db.query_drop("SELECT revision FROM rust_entity_revisions LIMIT 0")
            .map_err(failure)?;
        db.query_drop("SELECT revision FROM rust_local_values LIMIT 0")
            .map_err(failure)?;
        db.query_drop("SELECT seq FROM rust_changes LIMIT 0")
            .map_err(failure)?;
        let database: String = db
            .query_first("SELECT DATABASE()")
            .map_err(failure)?
            .ok_or("invalid_database")?;
        let lock_name = format!(
            "shufang:{:x}",
            Sha256::digest(format!("{database}\0{workspace}").as_bytes())
        );
        // GET_LOCK names have a 64 character maximum.
        let lock_name = lock_name[..64].to_string();
        let writer = if read_only {
            None
        } else {
            let mut conn = Conn::new(opts).map_err(failure)?;
            let acquired: Option<u8> = conn
                .exec_first("SELECT GET_LOCK(?,0)", (&lock_name,))
                .map_err(failure)?;
            if acquired != Some(1) {
                return Err("writer_already_running".into());
            }
            db.exec_drop(
                "INSERT IGNORE INTO sync_heads(workspace,node_id,epoch) VALUES(?,?,?)",
                (workspace, node, uuid::Uuid::new_v4().to_string()),
            )
            .map_err(failure)?;
            Some(std::sync::Mutex::new(conn))
        };
        let actual: Option<String> = db
            .exec_first(
                "SELECT node_id FROM sync_heads WHERE workspace=?",
                (workspace,),
            )
            .map_err(failure)?;
        let actual = actual.ok_or("workspace_not_found")?;
        if !read_only && actual != node {
            return Err("node_identity_mismatch".into());
        }
        Ok(Self {
            pool,
            workspace: workspace.into(),
            node: actual,
            read_only,
            writer,
            lock_name,
        })
    }
    fn writer_connection(&self) -> Result<std::sync::MutexGuard<'_, Conn>> {
        if self.read_only {
            return Err("read_only_replica".into());
        }
        self.writer
            .as_ref()
            .ok_or("writer_lease_lost")?
            .lock()
            .map_err(|_| "writer_lease_lost".into())
    }
    fn writable(&self) -> Result<()> {
        let mut writer = self.writer_connection()?;
        let owner: Option<Option<u32>> = writer
            .exec_first("SELECT IS_USED_LOCK(?)", (&self.lock_name,))
            .map_err(failure)?;
        if owner.flatten() != Some(writer.connection_id()) {
            return Err("writer_lease_lost".into());
        }
        Ok(())
    }
    fn head_tx(&self, tx: &mut Transaction<'_>) -> Result<(u64, String)> {
        let row: Option<(String, u64, String)> = tx
            .exec_first(
                "SELECT node_id,seq,clock FROM sync_heads WHERE workspace=? FOR UPDATE",
                (&self.workspace,),
            )
            .map_err(failure)?;
        let (node, seq, clock) = row.ok_or("workspace_not_found")?;
        if node != self.node {
            return Err("node_identity_mismatch".into());
        }
        Ok((seq, clock))
    }
    fn batch(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
        locals: &[LocalCommit],
        remote: bool,
        shared: bool,
    ) -> Result<()> {
        self.writable()?;
        if commits.len() > 10000 || locals.len() > 100 {
            return Err("invalid_batch".into());
        }
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        let (mut seq, mut clock) = self.head_tx(&mut tx)?;
        if clock != expected_clock {
            return Err("clock_conflict".into());
        }
        let mut digest_hashes = std::collections::BTreeSet::new();
        for commit in commits {
            let op = &commit.operation;
            shufang_domain::sync::validate_operation(op)?;
            if op.workspace_id != self.workspace || (!remote && op.replica_id != self.node) {
                return Err("identity_mismatch".into());
            }
            let existing: Option<String> = tx
                .exec_first(
                    "SELECT body FROM sync_operations WHERE workspace=? AND operation_id=?",
                    (&self.workspace, &op.operation_id),
                )
                .map_err(failure)?;
            if let Some(raw) = existing {
                return Err(if shufang_domain::sync::equivalent_operation(
                    &parse::<Operation>(&raw)?,
                    op,
                ) {
                    "revision_conflict"
                } else {
                    "operation_id_reused"
                }
                .into());
            }
            let prior = read_entity(&mut tx, &self.workspace, &op.kind, &op.entity_id)?;
            if op.kind == "books" {
                if let Some(hash) = prior
                    .as_ref()
                    .and_then(|v| v.state.fields.get("contentHash"))
                    .and_then(|v| v.value.as_ref())
                    .and_then(Value::as_str)
                {
                    digest_hashes.insert(hash.to_owned());
                }
            }
            if prior.as_ref().map_or(0, |v| v.revision) != commit.expected {
                return Err("revision_conflict".into());
            }
            if apply_operation(prior.as_ref().map(|v| &v.state), op)? != commit.state {
                return Err("operation_state_mismatch".into());
            }
            if !remote && !shared && compare_clock(&op.clock, &clock)? != Ordering::Greater {
                return Err("clock_conflict".into());
            }
            let revision = commit.expected.checked_add(1).ok_or("revision_overflow")?;

            seq = seq.checked_add(1).ok_or("sequence_overflow")?;
            let raw = stringify(op)?;
            let canonical = shufang_domain::lossless_json::Json::parse(&raw)?.stringify(true);
            let digest = format!("{:x}", Sha256::digest(canonical.as_bytes()));
            tx.exec_drop("INSERT INTO sync_operations(workspace,operation_id,seq,digest,body) VALUES(?,?,?,?,?)",(&self.workspace,&op.operation_id,seq,digest,canonical)).map_err(failure)?;
            tx.exec_drop("INSERT INTO sync_entities(workspace,kind,entity_id,state) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state)",(&self.workspace,&op.kind,&op.entity_id,stringify(&commit.state)?)).map_err(failure)?;
            tx.exec_drop("INSERT INTO rust_entity_revisions VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision)",(&self.workspace,&op.kind,&op.entity_id,revision)).map_err(failure)?;
            let snapshot = if remote {
                json!({"version":1,"replicated":true})
            } else {
                let value = shufang_domain::sync::materialize(if commit.state.deleted {
                    prior.as_ref().map(|v| &v.state).unwrap_or(&commit.state)
                } else {
                    &commit.state
                })?;
                let mut related = serde_json::Map::new();
                for (kind, field) in [("books", "bookId"), ("folders", "folderId")] {
                    let mut records = Vec::new();
                    if let Some(id) = value.as_ref().and_then(|v| v[field].as_str()) {
                        if let Some(row) = read_entity(&mut tx, &self.workspace, kind, id)? {
                            if let Some(value) = shufang_domain::sync::materialize(&row.state)? {
                                records.push(json!({"revision":row.revision,"value":value}));
                            }
                        }
                    }
                    related.insert(kind.into(), records.into());
                }
                json!({"version":1,"record":{"revision":revision,"value":value},"related":related})
            };
            tx.exec_drop("INSERT INTO rust_changes(workspace,kind,entity_id,revision,deleted,snapshot) VALUES(?,?,?,?,?,?)",(&self.workspace,&op.kind,&op.entity_id,revision,commit.state.deleted,stringify(&snapshot)?)).map_err(failure)?;
            if compare_clock(&op.clock, &clock)? == Ordering::Greater {
                clock = op.clock.clone()
            }
        }
        cleanup_digests(&mut tx, &self.workspace, &digest_hashes)?;
        let mut keys = std::collections::BTreeSet::new();
        for value in locals {
            if !keys.insert(&value.key) {
                return Err("invalid_local_key".into());
            }
            write_local(&mut tx, &self.workspace, value)?;
        }
        tx.exec_drop(
            "UPDATE sync_heads SET seq=?,clock=? WHERE workspace=?",
            (seq, clock, &self.workspace),
        )
        .map_err(failure)?;
        tx.commit().map_err(failure)
    }
    pub fn list_versions(&self) -> Result<Vec<(String, u64)>> {
        self.pool.get_conn().map_err(failure)?.exec("SELECT id,CAST(UNIX_TIMESTAMP(created_at)*1000 AS UNSIGNED) FROM sync_snapshots WHERE workspace=? AND id LIKE 'version-%' ORDER BY created_at DESC,id DESC",(&self.workspace,)).map_err(failure)
    }
    pub fn delete_version(&mut self, id: &str) -> Result<()> {
        self.writable()?;
        if !id.starts_with("version-") || !shufang_domain::sync::valid_identifier(id) {
            return Err("invalid_version_id".into());
        }
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        self.head_tx(&mut tx)?;
        let workspace: Option<String> = tx
            .exec_first(
                "SELECT workspace FROM sync_snapshots WHERE id=? FOR UPDATE",
                (id,),
            )
            .map_err(failure)?;
        if workspace.as_deref() != Some(self.workspace.as_str()) {
            return Err("version_not_found".into());
        }
        tx.exec_drop(
            "DELETE FROM sync_snapshot_entities WHERE snapshot_id=?",
            (id,),
        )
        .map_err(failure)?;
        tx.exec_drop(
            "DELETE FROM sync_snapshots WHERE id=? AND workspace=?",
            (id, &self.workspace),
        )
        .map_err(failure)?;
        tx.commit().map_err(failure)
    }
    pub fn version_entity(&self, version: &str, kind: &str, id: &str) -> Result<EntityState> {
        let row:Option<String>=self.pool.get_conn().map_err(failure)?.exec_first("SELECT e.state FROM sync_snapshot_entities e JOIN sync_snapshots s ON s.id=e.snapshot_id WHERE s.workspace=? AND s.id=? AND e.kind=? AND e.entity_id=?",(&self.workspace,version,kind,id)).map_err(failure)?;
        parse(&row.ok_or("version_not_found")?)
    }
}
impl Repository for MysqlRepository {
    fn load(&self, kind: &str, id: &str) -> Result<Option<StoredEntity>> {
        read_entity(
            &mut self.pool.get_conn().map_err(failure)?,
            &self.workspace,
            kind,
            id,
        )
    }
    fn list(&self, kind: &str) -> Result<Vec<StoredEntity>> {
        let mut db = self.pool.get_conn().map_err(failure)?;
        let rows:Vec<(String,u64)>=db.exec("SELECT e.state,COALESCE(r.revision,1) FROM sync_entities e LEFT JOIN rust_entity_revisions r ON r.workspace=e.workspace AND r.kind=e.kind AND r.entity_id=e.entity_id WHERE e.workspace=? AND e.kind=? ORDER BY e.entity_id",(&self.workspace,kind)).map_err(failure)?;
        rows.into_iter()
            .map(|(raw, revision)| {
                Ok(StoredEntity {
                    revision,
                    state: parse(&raw)?,
                })
            })
            .collect()
    }
    fn clock(&self) -> Result<String> {
        self.pool
            .get_conn()
            .map_err(failure)?
            .exec_first(
                "SELECT clock FROM sync_heads WHERE workspace=?",
                (&self.workspace,),
            )
            .map_err(failure)?
            .ok_or("workspace_not_found".into())
    }
    fn commit(&mut self, expected: u64, state: &EntityState, operation: &Operation) -> Result<()> {
        self.commit_batch(
            &self.clock()?,
            &[Commit {
                expected,
                state: state.clone(),
                operation: operation.clone(),
            }],
        )
    }
    fn commit_batch(&mut self, clock: &str, commits: &[Commit]) -> Result<()> {
        self.batch(clock, commits, &[], false, false)
    }
    fn commit_batch_local(
        &mut self,
        clock: &str,
        commits: &[Commit],
        locals: &[LocalCommit],
    ) -> Result<()> {
        self.batch(clock, commits, locals, false, false)
    }
    fn pending(&self) -> Result<Vec<Operation>> {
        let rows: Vec<String> = self
            .pool
            .get_conn()
            .map_err(failure)?
            .exec(
                "SELECT body FROM sync_operations WHERE workspace=? ORDER BY seq",
                (&self.workspace,),
            )
            .map_err(failure)?;
        rows.iter().map(|v| parse(v)).collect()
    }
    fn changes(&self, after: u64, limit: u32) -> Result<Vec<Change>> {
        let rows:Vec<(u64,String,String,u64,bool,Option<String>)>=self.pool.get_conn().map_err(failure)?.exec("SELECT seq,kind,entity_id,revision,deleted,snapshot FROM rust_changes WHERE workspace=? AND seq>? ORDER BY seq LIMIT ?",(&self.workspace,after,limit.clamp(1,1000))).map_err(failure)?;
        rows.into_iter()
            .map(|(sequence, kind, id, revision, deleted, raw)| {
                Ok(Change {
                    sequence,
                    kind,
                    id,
                    revision,
                    deleted,
                    snapshot: raw.as_deref().map(parse).transpose()?,
                })
            })
            .collect()
    }
    fn get_local(&self, key: &str) -> Result<Option<(u64, Value)>> {
        if let Some(hash) = digest_hash(key)? {
            let mut db = self.pool.get_conn().map_err(failure)?;
            let revision = local(&mut db, &self.workspace, key)?.map_or(0, |v| v.0);
            type DigestRow = (u64, String, String, String, String, Option<String>, String);
            let row:Option<DigestRow>=db.exec_first("SELECT id,content_hash,title,author,structure,overview,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.000Z') FROM book_digests WHERE content_hash=?",(hash,)).map_err(failure)?;
            return Ok(row.map(|(id,content_hash,title,author,structure,overview,created_at)|(revision,json!({"id":id,"contentHash":content_hash,"title":title,"author":author,"structure":structure,"overview":overview,"createdAt":created_at}))));
        }

        if key == "sync:credentials" {
            let mut db = self.pool.get_conn().map_err(failure)?;
            let revision = local(&mut db, &self.workspace, key)?.map_or(0, |v| v.0);
            let rows:Vec<(String,String)>=db.exec("SELECT credential_id,digest FROM sync_credentials WHERE workspace=? AND revoked=0",(&self.workspace,)).map_err(failure)?;
            let values: serde_json::Map<String, Value> = rows
                .into_iter()
                .map(|(id, digest)| (id, Value::String(digest)))
                .collect();
            return Ok(Some((revision, Value::Object(values))));
        }
        local(
            &mut self.pool.get_conn().map_err(failure)?,
            &self.workspace,
            key,
        )
    }
    fn set_local(&mut self, key: &str, expected: u64, value: &Value) -> Result<u64> {
        self.writable()?;
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        self.head_tx(&mut tx)?;
        let revision = write_local(
            &mut tx,
            &self.workspace,
            &LocalCommit {
                key: key.into(),
                expected,
                value: value.clone(),
            },
        )?;
        tx.commit().map_err(failure)?;
        Ok(revision)
    }
    fn local_usage(&self, prefix: &str) -> Result<(u64, u64)> {
        self.pool.get_conn().map_err(failure)?.exec_first("SELECT COUNT(*),CAST(COALESCE(SUM(OCTET_LENGTH(value_json)),0) AS UNSIGNED) FROM rust_local_values WHERE workspace=? AND LEFT(local_key,CHAR_LENGTH(?))=?",(&self.workspace,prefix,prefix)).map_err(failure)?.ok_or("storage_error".into())
    }
    fn delete_expired_local(&mut self, prefix: &str, now: u64, limit: u32) -> Result<u64> {
        let mut db = self.writer_connection()?;
        db.exec_drop("DELETE FROM rust_local_values WHERE workspace=? AND LEFT(local_key,CHAR_LENGTH(?))=? AND JSON_TYPE(JSON_EXTRACT(value_json,'$.expires'))='INTEGER' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(value_json,'$.expires')) AS UNSIGNED)<? LIMIT ?",(&self.workspace,prefix,prefix,now,limit.min(1000))).map_err(failure)?;
        Ok(db.affected_rows())
    }
}
impl ReplicationRepository for MysqlRepository {
    fn mutation_batch_local(
        &mut self,
        clock: &str,
        commits: &[Commit],
        locals: &[LocalCommit],
    ) -> Result<()> {
        self.batch(clock, commits, locals, false, true)
    }

    fn mutation_batch(&mut self, clock: &str, commits: &[Commit]) -> Result<()> {
        self.batch(clock, commits, &[], false, true)
    }
    fn replication_head(&self) -> Result<ReplicationHead> {
        let row: Option<(String, String, u64, String)> = self
            .pool
            .get_conn()
            .map_err(failure)?
            .exec_first(
                "SELECT node_id,epoch,seq,clock FROM sync_heads WHERE workspace=?",
                (&self.workspace,),
            )
            .map_err(failure)?;
        let (node_id, epoch, seq, clock) = row.ok_or("workspace_not_found")?;
        Ok(ReplicationHead {
            workspace_id: self.workspace.clone(),
            node_id,
            epoch,
            sequence: seq.to_string(),
            clock,
        })
    }
    fn operation(&self, id: &str) -> Result<Option<Operation>> {
        let raw: Option<String> = self
            .pool
            .get_conn()
            .map_err(failure)?
            .exec_first(
                "SELECT body FROM sync_operations WHERE workspace=? AND operation_id=?",
                (&self.workspace, id),
            )
            .map_err(failure)?;
        raw.as_deref().map(parse).transpose()
    }
    fn operation_sequence(&self, id: &str) -> Result<Option<u64>> {
        self.pool
            .get_conn()
            .map_err(failure)?
            .exec_first(
                "SELECT seq FROM sync_operations WHERE workspace=? AND operation_id=?",
                (&self.workspace, id),
            )
            .map_err(failure)
    }
    fn entity_history(&self, kind: &str, id: &str) -> Result<Vec<Operation>> {
        let rows:Vec<String>=self.pool.get_conn().map_err(failure)?.exec("SELECT body FROM sync_operations WHERE workspace=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.kind'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.entityId'))=? ORDER BY seq DESC LIMIT 100",(&self.workspace,kind,id)).map_err(failure)?;
        rows.iter().map(|r| parse(r)).collect()
    }
    fn replication_operations(&self, after: u64, limit: u32) -> Result<Vec<LogOperation>> {
        let rows:Vec<(u64,String)>=self.pool.get_conn().map_err(failure)?.exec("SELECT seq,body FROM sync_operations WHERE workspace=? AND seq>? ORDER BY seq LIMIT ?",(&self.workspace,after,limit.clamp(1,100))).map_err(failure)?;
        rows.into_iter()
            .map(|(sequence, raw)| {
                Ok(LogOperation {
                    sequence,
                    operation: parse(&raw)?,
                })
            })
            .collect()
    }
    fn receive_batch(
        &mut self,
        clock: &str,
        commits: &[Commit],
        checkpoint: Option<&LocalCommit>,
    ) -> Result<()> {
        if commits.len() > 100 {
            return Err("invalid_batch".into());
        }
        self.batch(
            clock,
            commits,
            &checkpoint.cloned().into_iter().collect::<Vec<_>>(),
            true,
            true,
        )
    }
    fn replication_entities(&self, kind: Option<&str>, after: &str) -> Result<Vec<EntityState>> {
        let rows:Vec<String>=self.pool.get_conn().map_err(failure)?.exec("SELECT state FROM sync_entities WHERE workspace=? AND (? IS NULL OR kind=?) AND CONCAT(kind,':',entity_id)>? ORDER BY kind,entity_id LIMIT 100",(&self.workspace,kind,kind,after)).map_err(failure)?;
        rows.iter().map(|r| parse(r)).collect()
    }
    fn create_snapshot(
        &mut self,
        id: &str,
        checkpoint: &str,
        expected: u64,
        now: u64,
    ) -> Result<()> {
        self.writable()?;
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        if self.head_tx(&mut tx)?.0 != expected {
            return Err("snapshot_head_changed".into());
        }
        tx.exec_drop("DELETE e FROM sync_snapshot_entities e JOIN sync_snapshots s ON s.id=e.snapshot_id WHERE s.workspace=? AND s.id NOT LIKE 'version-%' AND s.created_at<FROM_UNIXTIME(?)",(&self.workspace,now.saturating_sub(86400000)/1000)).map_err(failure)?;
        tx.exec_drop("DELETE FROM sync_snapshots WHERE workspace=? AND id NOT LIKE 'version-%' AND created_at<FROM_UNIXTIME(?)",(&self.workspace,now.saturating_sub(86400000)/1000)).map_err(failure)?;
        tx.exec_drop("INSERT INTO sync_snapshots(id,workspace,checkpoint,created_at) VALUES(?,?,?,FROM_UNIXTIME(?))",(id,&self.workspace,checkpoint,now/1000)).map_err(failure)?;
        tx.exec_drop("INSERT INTO sync_snapshot_entities SELECT ?,kind,entity_id,state FROM sync_entities WHERE workspace=?",(id,&self.workspace)).map_err(failure)?;
        tx.commit().map_err(failure)
    }
    fn snapshot_page(&self, id: &str, after: &str) -> Result<(String, Vec<EntityState>)> {
        let mut db = self.pool.get_conn().map_err(failure)?;
        let checkpoint: Option<String> = db
            .exec_first(
                "SELECT checkpoint FROM sync_snapshots WHERE id=? AND workspace=?",
                (id, &self.workspace),
            )
            .map_err(failure)?;
        let rows:Vec<String>=db.exec("SELECT state FROM sync_snapshot_entities WHERE snapshot_id=? AND CONCAT(kind,':',entity_id)>? ORDER BY kind,entity_id LIMIT 100",(id,after)).map_err(failure)?;
        Ok((
            checkpoint.ok_or("snapshot_not_found")?,
            rows.iter().map(|r| parse(r)).collect::<Result<_>>()?,
        ))
    }
}
