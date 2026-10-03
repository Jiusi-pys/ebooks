use super::*;
use shufang_application::{
    replica::{ReplicaCommit, ReplicaRepository, StoredReplica},
    LocalCommit,
};
use shufang_domain::lossless_sync::{ReplicaOperation, ReplicaState};
impl ReplicaRepository for SqliteRepository {
    fn replica_clock(&self) -> Result<String> {
        self.clock()
    }
    fn load_replica(&self, kind: &str, id: &str) -> Result<Option<StoredReplica>> {
        let row: Option<(u64, String)> = self
            .connection
            .query_row(
                "SELECT revision,state_json FROM entities WHERE kind=? AND id=?",
                params![kind, id],
                |r| Ok((read_revision(r)?, r.get(1)?)),
            )
            .optional()
            .map_err(failure)?;
        row.map(|(revision, raw)| {
            Ok(StoredReplica {
                revision,
                state: ReplicaState::parse(&raw)?,
            })
        })
        .transpose()
    }
    fn replica_operation(&self, id: &str) -> Result<Option<ReplicaOperation>> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT operation_json FROM outbox WHERE operation_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        raw.as_deref().map(ReplicaOperation::parse).transpose()
    }
    fn receive_replica_batch(
        &mut self,
        expected_clock: &str,
        commits: &[ReplicaCommit],
        checkpoint: Option<&LocalCommit>,
    ) -> Result<()> {
        if commits.len() > 100 {
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
            let op = &commit.operation;
            op.validate()?;
            if op.workspace_id != self.workspace {
                return Err("workspace_identity_mismatch".into());
            }
            let existing: Option<String> = tx
                .query_row(
                    "SELECT operation_json FROM outbox WHERE operation_id=?",
                    [&op.operation_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(failure)?;
            if let Some(raw) = existing {
                if ReplicaOperation::parse(&raw)? != *op {
                    return Err("operation_id_reused".into());
                }
                return Err("revision_conflict".into());
            }
            let prior: Option<(u64, String)> = tx
                .query_row(
                    "SELECT revision,state_json FROM entities WHERE kind=? AND id=?",
                    params![op.kind, op.entity_id],
                    |r| Ok((read_revision(r)?, r.get(1)?)),
                )
                .optional()
                .map_err(failure)?;
            if prior.as_ref().map_or(0, |r| r.0) != commit.expected {
                return Err("revision_conflict".into());
            }
            let state = prior
                .as_ref()
                .map(|(_, raw)| ReplicaState::parse(raw))
                .transpose()?;
            if ReplicaState::apply(state.as_ref(), op)? != commit.state {
                return Err("operation_state_mismatch".into());
            }
            let revision =
                i64::try_from(commit.expected.checked_add(1).ok_or("revision_overflow")?)
                    .map_err(failure)?;
            tx.execute("INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json",params![op.kind,op.entity_id,revision,commit.state.stringify()]).map_err(failure)?;
            tx.execute(
                "INSERT INTO outbox(operation_id,operation_json) VALUES(?,?)",
                params![op.operation_id, op.stringify()],
            )
            .map_err(failure)?;
            tx.execute(
                "INSERT INTO change_log(kind,entity_id,revision,deleted) VALUES(?,?,?,?)",
                params![op.kind, op.entity_id, revision, commit.state.deleted],
            )
            .map_err(failure)?;
            let sequence = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO local_values VALUES(?,1,?)",
                params![
                    format!("journal:{sequence}"),
                    r#"{"version":1,"replicated":true}"#
                ],
            )
            .map_err(failure)?;
            if compare_clock(&op.clock, &clock)? == Ordering::Greater {
                clock = op.clock.clone();
            }
        }
        tx.execute("UPDATE core_meta SET value=? WHERE key='clock'", [clock])
            .map_err(failure)?;
        if let Some(cp) = checkpoint {
            if !cp.key.starts_with("sync:") || cp.key.len() > 256 {
                return Err("invalid_sync_key".into());
            }
            let current: Option<u64> = tx
                .query_row(
                    "SELECT revision FROM local_values WHERE key=?",
                    [&cp.key],
                    read_revision,
                )
                .optional()
                .map_err(failure)?;
            if current.unwrap_or(0) != cp.expected {
                return Err("revision_conflict".into());
            }
            let revision = i64::try_from(cp.expected.checked_add(1).ok_or("revision_overflow")?)
                .map_err(failure)?;
            tx.execute("INSERT INTO local_values VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json",params![cp.key,revision,serde_json::to_string(&cp.value).map_err(failure)?]).map_err(failure)?;
        }
        tx.commit().map_err(failure)
    }
}
