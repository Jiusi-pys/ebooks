use super::*;
use shufang_application::{LocalCommit, LogOperation, ReplicationHead, ReplicationRepository};
impl ReplicationRepository for SqliteRepository {
    fn mutation_batch(&mut self, expected_clock: &str, commits: &[Commit]) -> Result<()> {
        self.commit_local_batch(expected_clock, commits, &[], true)
    }
    fn replication_entities(&self, kind: Option<&str>, after: &str) -> Result<Vec<EntityState>> {
        let mut q=self.connection.prepare("SELECT state_json FROM entities WHERE (?1 IS NULL OR kind=?1) AND kind||':'||id>?2 ORDER BY kind,id LIMIT 100").map_err(failure)?;
        let rows = q
            .query_map(params![kind, after], |r| r.get::<_, String>(0))
            .map_err(failure)?;
        rows.map(|s| serde_json::from_str(&s.map_err(failure)?).map_err(failure))
            .collect()
    }
    fn create_snapshot(
        &mut self,
        id: &str,
        checkpoint: &str,
        expected_sequence: u64,
        now: u64,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let head: u64 = tx
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM outbox",
                [],
                read_revision,
            )
            .map_err(failure)?;
        if head != expected_sequence {
            return Err("snapshot_head_changed".into());
        }
        // Network snapshots are resumable for one day. Named version snapshots
        // are operator-owned and are removed only by an explicit delete.
        let cutoff = i64::try_from(now.saturating_sub(86_400_000)).map_err(failure)?;
        tx.execute("DELETE FROM sync_snapshot_entities WHERE snapshot_id IN (SELECT id FROM sync_snapshots WHERE id NOT LIKE 'version-%' AND created_at < ?)", [cutoff]).map_err(failure)?;
        tx.execute(
            "DELETE FROM sync_snapshots WHERE id NOT LIKE 'version-%' AND created_at < ?",
            [cutoff],
        )
        .map_err(failure)?;
        tx.execute(
            "INSERT INTO sync_snapshots VALUES(?,?,?)",
            params![id, checkpoint, i64::try_from(now).map_err(failure)?],
        )
        .map_err(failure)?;
        tx.execute(
            "INSERT INTO sync_snapshot_entities SELECT ?,kind,id,state_json FROM entities",
            [id],
        )
        .map_err(failure)?;
        tx.commit().map_err(failure)
    }
    fn snapshot_page(&self, id: &str, after: &str) -> Result<(String, Vec<EntityState>)> {
        let checkpoint: Option<String> = self
            .connection
            .query_row(
                "SELECT checkpoint FROM sync_snapshots WHERE id=?",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        let mut q=self.connection.prepare("SELECT state_json FROM sync_snapshot_entities WHERE snapshot_id=? AND kind||':'||entity_id>? ORDER BY kind,entity_id LIMIT 100").map_err(failure)?;
        let rows = q
            .query_map(params![id, after], |r| r.get::<_, String>(0))
            .map_err(failure)?;
        let states = rows
            .map(|s| serde_json::from_str(&s.map_err(failure)?).map_err(failure))
            .collect::<Result<Vec<_>>>()?;
        Ok((checkpoint.ok_or("snapshot_not_found")?, states))
    }
    fn replication_head(&self) -> Result<ReplicationHead> {
        let epoch = self
            .connection
            .query_row(
                "SELECT value FROM core_meta WHERE key='sync_epoch'",
                [],
                |r| r.get(0),
            )
            .map_err(failure)?;
        let sequence: u64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM outbox",
                [],
                read_revision,
            )
            .map_err(failure)?;
        Ok(ReplicationHead {
            workspace_id: self.workspace.clone(),
            node_id: self.replica.clone(),
            epoch,
            sequence: sequence.to_string(),
            clock: self.clock()?,
        })
    }
    fn entity_history(&self, kind: &str, id: &str) -> Result<Vec<Operation>> {
        let mut q=self.connection.prepare("SELECT operation_json FROM outbox WHERE json_extract(operation_json,'$.kind')=? AND json_extract(operation_json,'$.entityId')=? ORDER BY sequence DESC LIMIT 100").map_err(failure)?;
        let rows = q
            .query_map(params![kind, id], |r| r.get::<_, String>(0))
            .map_err(failure)?;
        rows.map(|s| serde_json::from_str(&s.map_err(failure)?).map_err(failure))
            .collect()
    }
    fn operation_sequence(&self, id: &str) -> Result<Option<u64>> {
        self.connection
            .query_row(
                "SELECT sequence FROM outbox WHERE operation_id=?",
                [id],
                read_revision,
            )
            .optional()
            .map_err(failure)
    }
    fn operation(&self, id: &str) -> Result<Option<Operation>> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT operation_json FROM outbox WHERE operation_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        raw.map(|s| serde_json::from_str(&s).map_err(failure))
            .transpose()
    }
    fn replication_operations(&self, after: u64, limit: u32) -> Result<Vec<LogOperation>> {
        let mut q=self.connection.prepare("SELECT sequence,operation_json FROM outbox WHERE sequence>? ORDER BY sequence LIMIT ?").map_err(failure)?;
        let rows = q
            .query_map(
                params![i64::try_from(after).map_err(failure)?, limit.clamp(1, 100)],
                |r| Ok((read_revision(r)?, r.get::<_, String>(1)?)),
            )
            .map_err(failure)?;
        rows.map(|row| {
            let (sequence, raw) = row.map_err(failure)?;
            Ok(LogOperation {
                sequence,
                operation: serde_json::from_str(&raw).map_err(failure)?,
            })
        })
        .collect()
    }
    fn receive_batch(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
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
            if op.workspace_id != self.workspace {
                return Err("workspace_identity_mismatch".into());
            }
            shufang_domain::sync::validate_operation(op)?;
            let existing: Option<String> = tx
                .query_row(
                    "SELECT operation_json FROM outbox WHERE operation_id=?",
                    [&op.operation_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(failure)?;
            if let Some(raw) = existing {
                if !shufang_domain::sync::equivalent_operation(
                    &serde_json::from_str::<Operation>(&raw).map_err(failure)?,
                    op,
                ) {
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
            let prior = prior
                .map(|(_, s)| serde_json::from_str(&s))
                .transpose()
                .map_err(failure)?;
            if shufang_domain::sync::apply_operation(prior.as_ref(), op)? != commit.state {
                return Err("operation_state_mismatch".into());
            }
            let revision =
                i64::try_from(commit.expected.checked_add(1).ok_or("revision_overflow")?)
                    .map_err(failure)?;
            tx.execute("INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json",params![op.kind,op.entity_id,revision,serde_json::to_string(&commit.state).map_err(failure)?]).map_err(failure)?;
            tx.execute(
                "INSERT INTO outbox(operation_id,operation_json) VALUES(?,?)",
                params![op.operation_id, serde_json::to_string(op).map_err(failure)?],
            )
            .map_err(failure)?;
            tx.execute(
                "INSERT INTO change_log(kind,entity_id,revision,deleted) VALUES(?,?,?,?)",
                params![op.kind, op.entity_id, revision, commit.state.deleted],
            )
            .map_err(failure)?;
            let change_sequence = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO local_values VALUES(?,1,?)",
                params![
                    format!("journal:{change_sequence}"),
                    r#"{"version":1,"replicated":true}"#
                ],
            )
            .map_err(failure)?;
            // Remote operations are replayed, never converted into new business commands.
            if compare_clock(&op.clock, &clock)? == Ordering::Greater {
                clock = op.clock.clone();
            }
        }
        tx.execute("UPDATE core_meta SET value=? WHERE key='clock'", [clock])
            .map_err(failure)?;
        if let Some(cp) = checkpoint {
            if cp.key.is_empty() || cp.key.len() > 256 {
                return Err("invalid_local_key".into());
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
