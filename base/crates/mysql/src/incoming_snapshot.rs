use super::*;
use serde::{Deserialize, Serialize};
use shufang_application::incoming_snapshot::{IncomingSnapshot, SnapshotPage, SnapshotRepository};
use shufang_domain::lossless_sync::{field_clock, ReplicaState};
#[derive(Serialize, Deserialize, PartialEq)]
struct Page {
    version: u32,
    after: String,
    next: Option<String>,
    states: Vec<String>,
}
fn key(peer: &str) -> Result<String> {
    if !shufang_domain::sync::valid_identifier(peer) {
        return Err("invalid_snapshot_peer".into());
    }
    Ok(format!("sync:incoming:{peer}"))
}
fn prefix(peer: &str, id: &str) -> String {
    format!(
        "sync:incoming-page:{:x}:",
        Sha256::digest(format!("{peer}\0{id}").as_bytes())
    )
}
fn metadata<Q: Queryable>(
    db: &mut Q,
    workspace: &str,
    peer: &str,
) -> Result<Option<(u64, IncomingSnapshot)>> {
    local(db, workspace, &key(peer)?)?
        .map(|(revision, value)| {
            let snapshot: IncomingSnapshot = serde_json::from_value(value).map_err(failure)?;
            snapshot.validate()?;
            if snapshot.peer != peer {
                return Err("snapshot_identity_mismatch".into());
            }
            Ok((revision, snapshot))
        })
        .transpose()
}
impl SnapshotRepository for MysqlRepository {
    fn incoming_snapshot(&self, peer: &str) -> Result<Option<IncomingSnapshot>> {
        Ok(metadata(
            &mut self.pool.get_conn().map_err(failure)?,
            &self.workspace,
            peer,
        )?
        .map(|v| v.1))
    }
    fn begin_snapshot(&mut self, snapshot: &IncomingSnapshot) -> Result<()> {
        self.writable()?;
        snapshot.validate()?;
        if snapshot.pages != 0 || snapshot.next.as_deref() != Some("") {
            return Err("invalid_snapshot_start".into());
        }
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        self.head_tx(&mut tx)?;
        if let Some((_, existing)) = metadata(&mut tx, &self.workspace, &snapshot.peer)? {
            return if existing.id == snapshot.id
                && existing.epoch == snapshot.epoch
                && existing.watermark == snapshot.watermark
            {
                Ok(())
            } else {
                Err("snapshot_in_progress".into())
            };
        }
        write_local(
            &mut tx,
            &self.workspace,
            &LocalCommit {
                key: key(&snapshot.peer)?,
                expected: 0,
                value: serde_json::to_value(snapshot).map_err(failure)?,
            },
        )?;
        tx.commit().map_err(failure)
    }
    fn stage_snapshot_page(&mut self, peer: &str, id: &str, page: &SnapshotPage) -> Result<()> {
        self.writable()?;
        page.validate()?;
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        self.head_tx(&mut tx)?;
        let (revision, mut snapshot) =
            metadata(&mut tx, &self.workspace, peer)?.ok_or("snapshot_not_found")?;
        if snapshot.id != id {
            return Err("snapshot_identity_mismatch".into());
        }
        let page_key = format!("{}{:010}", prefix(peer, id), page.index);
        let stored = Page {
            version: 1,
            after: page.after.clone(),
            next: page.next.clone(),
            states: page.states.iter().map(ReplicaState::stringify).collect(),
        };
        let value = serde_json::to_value(&stored).map_err(failure)?;
        if let Some((_, prior)) = local(&mut tx, &self.workspace, &page_key)? {
            return if prior == value {
                Ok(())
            } else {
                Err("snapshot_page_reused".into())
            };
        }
        if snapshot.pages != page.index || snapshot.next.as_deref() != Some(page.after.as_str()) {
            return Err("snapshot_page_out_of_order".into());
        }
        write_local(
            &mut tx,
            &self.workspace,
            &LocalCommit {
                key: page_key,
                expected: 0,
                value,
            },
        )?;
        snapshot.pages += 1;
        snapshot.next = page.next.clone();
        write_local(
            &mut tx,
            &self.workspace,
            &LocalCommit {
                key: key(peer)?,
                expected: revision,
                value: serde_json::to_value(snapshot).map_err(failure)?,
            },
        )?;
        tx.commit().map_err(failure)
    }
    fn abandon_snapshot(&mut self, peer: &str, id: &str) -> Result<()> {
        self.writable()?;
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        self.head_tx(&mut tx)?;
        if let Some((_, snapshot)) = metadata(&mut tx, &self.workspace, peer)? {
            if snapshot.id != id {
                return Err("snapshot_identity_mismatch".into());
            }
            let prefix = prefix(peer, id);
            tx.exec_drop("DELETE FROM rust_local_values WHERE workspace=? AND (local_key=? OR LEFT(local_key,CHAR_LENGTH(?))=?)",(&self.workspace,key(peer)?,&prefix,&prefix)).map_err(failure)?;
        }
        tx.commit().map_err(failure)
    }
    fn finish_snapshot(&mut self, peer: &str, id: &str, checkpoint: &LocalCommit) -> Result<()> {
        self.writable()?;
        let mut db = self.writer_connection()?;
        let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
        let (_, mut clock) = self.head_tx(&mut tx)?;
        let (_, snapshot) =
            metadata(&mut tx, &self.workspace, peer)?.ok_or("snapshot_not_found")?;
        if snapshot.id != id || snapshot.pages == 0 || snapshot.next.is_some() {
            return Err("snapshot_incomplete".into());
        }
        if !checkpoint.key.starts_with("sync:")
            || checkpoint.key.starts_with("sync:incoming")
            || checkpoint.key.len() > 256
            || checkpoint.value.as_str() != Some(snapshot.watermark.as_str())
        {
            return Err("invalid_snapshot_checkpoint".into());
        }
        if local(&mut tx, &self.workspace, &checkpoint.key)?.map_or(0, |v| v.0)
            != checkpoint.expected
        {
            return Err("revision_conflict".into());
        }
        let prefix = prefix(peer, id);
        let mut digest_hashes = std::collections::BTreeSet::new();
        let mut seen = std::collections::BTreeSet::new();
        let mut after = String::new();
        for index in 0..snapshot.pages {
            let raw = local(&mut tx, &self.workspace, &format!("{prefix}{index:010}"))?
                .ok_or("snapshot_incomplete")?
                .1;
            let page: Page = serde_json::from_value(raw).map_err(failure)?;
            let states = page
                .states
                .iter()
                .map(|r| ReplicaState::parse(r))
                .collect::<Result<Vec<_>>>()?;
            SnapshotPage {
                index,
                after: page.after.clone(),
                next: page.next.clone(),
                states: states.clone(),
            }
            .validate()?;
            if page.version != 1
                || page.after != after
                || (index + 1 == snapshot.pages) != page.next.is_none()
            {
                return Err("invalid_snapshot_page".into());
            }
            after = page.next.clone().unwrap_or_default();
            for incoming in states {
                if !seen.insert((incoming.kind.clone(), incoming.id.clone())) {
                    return Err("duplicate_snapshot_entity".into());
                }
                let prior:Option<(String,u64)>=tx.exec_first("SELECT e.state,COALESCE(r.revision,1) FROM sync_entities e LEFT JOIN rust_entity_revisions r ON r.workspace=e.workspace AND r.kind=e.kind AND r.entity_id=e.entity_id WHERE e.workspace=? AND e.kind=? AND e.entity_id=?",(&self.workspace,&incoming.kind,&incoming.id)).map_err(failure)?;
                if incoming.kind == "books" {
                    if let Some(raw) = prior.as_ref() {
                        let value: EntityState = parse(&raw.0)?;
                        if let Some(hash) = value
                            .fields
                            .get("contentHash")
                            .and_then(|v| v.value.as_ref())
                            .and_then(Value::as_str)
                        {
                            digest_hashes.insert(hash.to_owned());
                        }
                    }
                }
                let state = prior
                    .as_ref()
                    .map(|v| ReplicaState::parse(&v.0))
                    .transpose()?;
                let merged = ReplicaState::merge(state.as_ref(), &incoming)?;
                for field in merged.fields.values() {
                    let next = field_clock(&field.version)?;
                    shufang_domain::sync::validate_received_clock(
                        &next,
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_err(|_| "invalid_system_clock")?
                            .as_millis()
                            .try_into()
                            .map_err(|_| "invalid_system_clock")?,
                    )?;
                    if compare_clock(&next, &clock)? == Ordering::Greater {
                        clock = next
                    }
                }
                if state.as_ref() == Some(&merged) {
                    continue;
                }
                let revision = prior
                    .map_or(0, |v| v.1)
                    .checked_add(1)
                    .ok_or("revision_overflow")?;
                tx.exec_drop("INSERT INTO sync_entities VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state)",(&self.workspace,&merged.kind,&merged.id,merged.stringify())).map_err(failure)?;
                tx.exec_drop("INSERT INTO rust_entity_revisions VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision)",(&self.workspace,&merged.kind,&merged.id,revision)).map_err(failure)?;
                tx.exec_drop("INSERT INTO rust_changes(workspace,kind,entity_id,revision,deleted,snapshot) VALUES(?,?,?,?,?,?)",(&self.workspace,&merged.kind,&merged.id,revision,merged.deleted,r#"{"version":1,"replicated":true,"snapshot":true}"#)).map_err(failure)?;
            }
        }
        cleanup_digests(&mut tx, &self.workspace, &digest_hashes)?;
        tx.exec_drop(
            "UPDATE sync_heads SET clock=? WHERE workspace=?",
            (clock, &self.workspace),
        )
        .map_err(failure)?;
        write_local(&mut tx, &self.workspace, checkpoint)?;
        tx.exec_drop("DELETE FROM rust_local_values WHERE workspace=? AND (local_key=? OR LEFT(local_key,CHAR_LENGTH(?))=?)",(&self.workspace,key(peer)?,&prefix,&prefix)).map_err(failure)?;
        tx.commit().map_err(failure)
    }
}
