use super::*;
use serde::{Deserialize, Serialize};
use shufang_application::{
    incoming_snapshot::{IncomingSnapshot, SnapshotPage, SnapshotRepository},
    LocalCommit,
};
use shufang_domain::lossless_sync::{field_clock, ReplicaState};

#[derive(Serialize, Deserialize, PartialEq)]
struct StoredPage {
    version: u32,
    after: String,
    next: Option<String>,
    states: Vec<String>,
}
fn metadata_key(peer: &str) -> Result<String> {
    if !shufang_domain::sync::valid_identifier(peer) {
        return Err("invalid_snapshot_peer".into());
    }
    Ok(format!("sync:incoming:{peer}"))
}
fn page_prefix(peer: &str, id: &str) -> String {
    format!(
        "sync:incoming-page:{:x}:",
        Sha256::digest(format!("{peer}\0{id}").as_bytes())
    )
}
fn read_snapshot(connection: &Connection, peer: &str) -> Result<Option<IncomingSnapshot>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value_json FROM local_values WHERE key=?",
            [metadata_key(peer)?],
            |r| r.get(0),
        )
        .optional()
        .map_err(failure)?;
    raw.map(|raw| {
        let value: IncomingSnapshot = serde_json::from_str(&raw).map_err(failure)?;
        value.validate()?;
        if value.peer != peer {
            return Err("snapshot_identity_mismatch".into());
        }
        Ok(value)
    })
    .transpose()
}
fn write_metadata(connection: &Connection, snapshot: &IncomingSnapshot) -> Result<()> {
    connection.execute("INSERT INTO local_values VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET revision=revision+1,value_json=excluded.value_json",params![metadata_key(&snapshot.peer)?,serde_json::to_string(snapshot).map_err(failure)?]).map_err(failure)?;
    Ok(())
}
impl SnapshotRepository for SqliteRepository {
    fn incoming_snapshot(&self, peer: &str) -> Result<Option<IncomingSnapshot>> {
        read_snapshot(&self.connection, peer)
    }
    fn begin_snapshot(&mut self, snapshot: &IncomingSnapshot) -> Result<()> {
        snapshot.validate()?;
        if snapshot.pages != 0 || snapshot.next.as_deref() != Some("") {
            return Err("invalid_snapshot_start".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        if let Some(existing) = read_snapshot(&tx, &snapshot.peer)? {
            if existing.id == snapshot.id
                && existing.epoch == snapshot.epoch
                && existing.watermark == snapshot.watermark
            {
                return Ok(());
            }
            return Err("snapshot_in_progress".into());
        }
        write_metadata(&tx, snapshot)?;
        tx.commit().map_err(failure)
    }
    fn stage_snapshot_page(&mut self, peer: &str, id: &str, page: &SnapshotPage) -> Result<()> {
        page.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let mut snapshot = read_snapshot(&tx, peer)?.ok_or("snapshot_not_found")?;
        if snapshot.id != id {
            return Err("snapshot_identity_mismatch".into());
        }
        let page_key = format!("{}{:010}", page_prefix(peer, id), page.index);
        let serialized = StoredPage {
            version: 1,
            after: page.after.clone(),
            next: page.next.clone(),
            states: page.states.iter().map(ReplicaState::stringify).collect(),
        };
        let prior: Option<String> = tx
            .query_row(
                "SELECT value_json FROM local_values WHERE key=?",
                [&page_key],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        if let Some(prior) = prior {
            if serde_json::from_str::<StoredPage>(&prior).map_err(failure)? == serialized {
                return Ok(());
            }
            return Err("snapshot_page_reused".into());
        }
        if snapshot.pages != page.index || snapshot.next.as_deref() != Some(page.after.as_str()) {
            return Err("snapshot_page_out_of_order".into());
        }
        tx.execute(
            "INSERT INTO local_values VALUES(?,1,?)",
            params![
                page_key,
                serde_json::to_string(&serialized).map_err(failure)?
            ],
        )
        .map_err(failure)?;
        snapshot.pages += 1;
        snapshot.next = page.next.clone();
        write_metadata(&tx, &snapshot)?;
        tx.commit().map_err(failure)
    }
    fn abandon_snapshot(&mut self, peer: &str, id: &str) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        if let Some(snapshot) = read_snapshot(&tx, peer)? {
            if snapshot.id != id {
                return Err("snapshot_identity_mismatch".into());
            }
            let prefix = page_prefix(peer, id);
            tx.execute(
                "DELETE FROM local_values WHERE substr(key,1,?)=?",
                params![prefix.len() as i64, prefix],
            )
            .map_err(failure)?;
            tx.execute(
                "DELETE FROM local_values WHERE key=?",
                [metadata_key(peer)?],
            )
            .map_err(failure)?;
        }
        tx.commit().map_err(failure)
    }
    fn finish_snapshot(&mut self, peer: &str, id: &str, checkpoint: &LocalCommit) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let snapshot = read_snapshot(&tx, peer)?.ok_or("snapshot_not_found")?;
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
        let revision: Option<u64> = tx
            .query_row(
                "SELECT revision FROM local_values WHERE key=?",
                [&checkpoint.key],
                read_revision,
            )
            .optional()
            .map_err(failure)?;
        if revision.unwrap_or(0) != checkpoint.expected {
            return Err("revision_conflict".into());
        }
        let mut clock: String = tx
            .query_row("SELECT value FROM core_meta WHERE key='clock'", [], |r| {
                r.get(0)
            })
            .map_err(failure)?;
        let prefix = page_prefix(peer, id);
        let mut seen = std::collections::BTreeSet::new();
        let mut after = String::new();
        for index in 0..snapshot.pages {
            let page_key = format!("{prefix}{index:010}");
            let raw: String = tx
                .query_row(
                    "SELECT value_json FROM local_values WHERE key=?",
                    [&page_key],
                    |r| r.get(0),
                )
                .map_err(failure)?;
            let page: StoredPage = serde_json::from_str(&raw).map_err(failure)?;
            SnapshotPage {
                index,
                after: page.after.clone(),
                next: page.next.clone(),
                states: page
                    .states
                    .iter()
                    .map(|raw| ReplicaState::parse(raw))
                    .collect::<Result<Vec<_>>>()?,
            }
            .validate()?;
            if page.version != 1
                || page.after != after
                || (index + 1 == snapshot.pages) != page.next.is_none()
            {
                return Err("invalid_snapshot_page".into());
            }
            after = page.next.clone().unwrap_or_default();
            for raw in page.states {
                let incoming = ReplicaState::parse(&raw)?;
                if !seen.insert((incoming.kind.clone(), incoming.id.clone())) {
                    return Err("duplicate_snapshot_entity".into());
                }
                let prior: Option<(u64, String)> = tx
                    .query_row(
                        "SELECT revision,state_json FROM entities WHERE kind=? AND id=?",
                        params![incoming.kind, incoming.id],
                        |r| Ok((read_revision(r)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(failure)?;
                let state = prior
                    .as_ref()
                    .map(|(_, raw)| ReplicaState::parse(raw))
                    .transpose()?;
                let merged = ReplicaState::merge(state.as_ref(), &incoming)?;
                for field in merged.fields.values() {
                    let incoming_clock = field_clock(&field.version)?;
                    if compare_clock(&incoming_clock, &clock)? == Ordering::Greater {
                        clock = incoming_clock;
                    }
                }
                if state.as_ref() == Some(&merged) {
                    continue;
                }
                let expected = prior.as_ref().map_or(0, |r| r.0);
                let revision = i64::try_from(expected.checked_add(1).ok_or("revision_overflow")?)
                    .map_err(failure)?;
                tx.execute("INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json",params![merged.kind,merged.id,revision,merged.stringify()]).map_err(failure)?;
                tx.execute(
                    "INSERT INTO change_log(kind,entity_id,revision,deleted) VALUES(?,?,?,?)",
                    params![merged.kind, merged.id, revision, merged.deleted],
                )
                .map_err(failure)?;
                let sequence = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO local_values VALUES(?,1,?)",
                    params![
                        format!("journal:{sequence}"),
                        r#"{"version":1,"replicated":true,"snapshot":true}"#
                    ],
                )
                .map_err(failure)?;
            }
        }
        tx.execute("UPDATE core_meta SET value=? WHERE key='clock'", [clock])
            .map_err(failure)?;
        let revision = i64::try_from(
            checkpoint
                .expected
                .checked_add(1)
                .ok_or("revision_overflow")?,
        )
        .map_err(failure)?;
        tx.execute("INSERT INTO local_values VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json",params![checkpoint.key,revision,serde_json::to_string(&checkpoint.value).map_err(failure)?]).map_err(failure)?;
        tx.execute(
            "DELETE FROM local_values WHERE substr(key,1,?)=?",
            params![prefix.len() as i64, prefix],
        )
        .map_err(failure)?;
        tx.execute(
            "DELETE FROM local_values WHERE key=?",
            [metadata_key(peer)?],
        )
        .map_err(failure)?;
        tx.commit().map_err(failure)
    }
}
