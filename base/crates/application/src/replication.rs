use crate::{Commit, CoreSession, LocalCommit, Repository, Result, Runtime, StoredEntity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use shufang_domain::sync::{apply_operation, validate_operation, Operation};
use std::collections::BTreeMap;
pub fn retry_delay(failures: u32) -> u64 {
    5u64.saturating_mul(1u64 << failures.min(6)).min(300)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationHead {
    pub workspace_id: String,
    pub node_id: String,
    pub epoch: String,
    pub sequence: String,
    pub clock: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogOperation {
    pub sequence: u64,
    pub operation: Operation,
}
pub trait ReplicationRepository: Repository {
    /// Local v2 commands and their cascades share a clock and commit atomically.
    fn mutation_batch(&mut self, expected_clock: &str, commits: &[Commit]) -> Result<()>;
    fn mutation_batch_local(
        &mut self,
        clock: &str,
        commits: &[Commit],
        locals: &[LocalCommit],
    ) -> Result<()> {
        if !locals.is_empty() {
            return Err("atomic_local_mutation_unsupported".into());
        }
        self.mutation_batch(clock, commits)
    }
    fn replication_head(&self) -> Result<ReplicationHead>;
    fn operation(&self, id: &str) -> Result<Option<Operation>>;
    fn operation_sequence(&self, id: &str) -> Result<Option<u64>>;
    fn entity_history(&self, kind: &str, id: &str) -> Result<Vec<Operation>>;
    fn replication_operations(&self, after: u64, limit: u32) -> Result<Vec<LogOperation>>;
    fn receive_batch(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
        checkpoint: Option<&LocalCommit>,
    ) -> Result<()>;
    fn replication_entities(
        &self,
        kind: Option<&str>,
        after: &str,
    ) -> Result<Vec<shufang_domain::sync::EntityState>>;
    fn create_snapshot(
        &mut self,
        id: &str,
        checkpoint: &str,
        expected_sequence: u64,
        now: u64,
    ) -> Result<()>;
    fn snapshot_page(
        &self,
        id: &str,
        after: &str,
    ) -> Result<(String, Vec<shufang_domain::sync::EntityState>)>;
}
impl<R: ReplicationRepository, T: Runtime> CoreSession<R, T> {
    pub fn mutation_clock(&self, operation_id: &str) -> Result<String> {
        match self.repository.operation(operation_id)? {
            Some(prior) => Ok(prior.clock),
            None => shufang_domain::sync::next_clock(&self.repository.clock()?, self.runtime.now()),
        }
    }
    /// Local production command: externalize fields before committing a replayable operation.
    pub fn local_replica_command(
        &mut self,
        kind: &str,
        id: &str,
        operation_id: &str,
        patch: serde_json::Map<String, serde_json::Value>,
        unset: Vec<String>,
        deleted: bool,
    ) -> Result<(bool, u64)> {
        self.local_replica_command_with_creation(
            kind,
            id,
            operation_id,
            patch,
            unset,
            deleted,
            false,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn local_replica_command_with_creation(
        &mut self,
        kind: &str,
        id: &str,
        operation_id: &str,
        mut patch: serde_json::Map<String, serde_json::Value>,
        unset: Vec<String>,
        deleted: bool,
        create: bool,
    ) -> Result<(bool, u64)> {
        let clock = self.mutation_clock(operation_id)?;
        if create {
            let prior = self.repository.operation(operation_id)?;
            let now: u64 = clock
                .split(':')
                .next()
                .ok_or("invalid_clock")?
                .parse()
                .map_err(|_| "invalid_clock")?;
            // Older candidates could assign a default timestamp before the final
            // operation clock. Preserve that persisted value on retries too.
            let created = prior
                .as_ref()
                .and_then(|p| p.patch.get("createdAt"))
                .cloned()
                .unwrap_or(serde_json::json!(now));
            patch.entry("createdAt".to_owned()).or_insert(created);
            let updated = prior
                .as_ref()
                .and_then(|p| p.patch.get("updatedAt"))
                .cloned()
                .unwrap_or_else(|| patch["createdAt"].clone());
            patch.entry("updatedAt".to_owned()).or_insert(updated);
        }
        let mut operation = Operation {
            workspace_id: self.workspace.clone(),
            replica_id: self.replica.clone(),
            operation_id: operation_id.into(),
            kind: kind.into(),
            entity_id: id.into(),
            clock,
            patch,
            unset,
            deleted,
        };
        operation.patch = shufang_domain::sync::flatten_fields(kind, &operation.patch)?;
        validate_operation(&operation)?;
        shufang_domain::sync_validation::validate_patch(&operation)?;
        operation.patch = self.prepare_patch(operation.patch)?;
        self.mutate_replica_entity(operation)
    }
    pub fn mutate_replica_entity(&mut self, mut operation: Operation) -> Result<(bool, u64)> {
        operation.patch = shufang_domain::sync::flatten_fields(&operation.kind, &operation.patch)?;
        validate_operation(&operation)?;
        shufang_domain::sync_validation::validate_patch(&operation)?;
        if operation.workspace_id != self.workspace || operation.replica_id != self.replica {
            return Err("identity_mismatch".into());
        }
        if let Some(previous) = self.repository.operation(&operation.operation_id)? {
            if !shufang_domain::sync::equivalent_operation(&previous, &operation) {
                return Err("operation_id_reused".into());
            }
            return Ok((
                true,
                self.repository
                    .operation_sequence(&operation.operation_id)?
                    .ok_or("operation_not_persisted")?,
            ));
        }
        let clock = self.repository.clock()?;
        let prior = self
            .repository
            .load(&operation.kind, &operation.entity_id)?;
        if operation.kind == "reviews"
            && (operation.entity_id != operation.operation_id
                || operation.deleted
                || !operation.unset.is_empty()
                || prior.is_some())
        {
            return Err("review_events_are_immutable".into());
        }
        let mut commits = vec![Commit {
            expected: prior.as_ref().map_or(0, |p| p.revision),
            state: apply_operation(prior.as_ref().map(|p| &p.state), &operation)?,
            operation: operation.clone(),
        }];
        if operation.deleted {
            for kind in shufang_domain::sync::ENTITY_KINDS {
                for row in self.repository.list(kind)? {
                    let state = &row.state;
                    if state.kind == operation.kind && state.id == operation.entity_id {
                        continue;
                    }
                    let Some(data) = shufang_domain::sync::materialize(state)? else {
                        continue;
                    };
                    let mut deleted = false;
                    let mut unset = Vec::new();
                    if operation.kind == "books" {
                        deleted = (["highlights", "translations", "mindMaps"]
                            .contains(&state.kind.as_str())
                            && data["bookId"] == operation.entity_id)
                            || (state.kind == "sources" && state.id == operation.entity_id)
                            || (state.kind == "associations"
                                && ["source", "target"]
                                    .iter()
                                    .any(|key| data[key]["bookId"] == operation.entity_id));
                        let member = format!("@member:{}", operation.entity_id);
                        if state.kind == "studySets" && state.fields.contains_key(&member) {
                            unset.push(member);
                        }
                    }
                    if operation.kind == "folders"
                        && state.kind == "books"
                        && data["folderId"] == operation.entity_id
                    {
                        unset.push("folderId".into());
                    }
                    if operation.kind == "notes"
                        && state.kind == "highlights"
                        && data["noteId"] == operation.entity_id
                    {
                        unset.push("noteId".into());
                    }
                    if !deleted && unset.is_empty() {
                        continue;
                    }
                    let child = Operation {
                        kind: state.kind.clone(),
                        entity_id: state.id.clone(),
                        operation_id: format!(
                            "cascade-{:x}",
                            Sha256::digest(
                                format!("{}{}{}", operation.operation_id, state.kind, state.id)
                                    .as_bytes()
                            )
                        ),
                        patch: Default::default(),
                        unset,
                        deleted,
                        ..operation.clone()
                    };
                    commits.push(Commit {
                        expected: row.revision,
                        state: apply_operation(Some(state), &child)?,
                        operation: child,
                    });
                    if commits.len() > 10_000 {
                        return Err("invalid_batch".into());
                    }
                }
            }
        }
        let locals = self.pending_local.take().unwrap_or_default();
        self.repository
            .mutation_batch_local(&clock, &commits, &locals)?;
        Ok((
            false,
            self.repository
                .operation_sequence(&operation.operation_id)?
                .ok_or("operation_not_persisted")?,
        ))
    }
    pub fn replica_entity(&self, kind: &str, id: &str) -> Result<crate::Record> {
        if !shufang_domain::sync::ENTITY_KINDS.contains(&kind) {
            return Err("invalid_kind".into());
        }
        let row = self.repository.load(kind, id)?.ok_or("not_found")?;
        Ok(crate::Record {
            revision: row.revision,
            value: self
                .materialize_state(&row.state)?
                .ok_or("entity_deleted")?,
            pending_fields: vec![],
        })
    }
    pub fn entity_history(&self, kind: &str, id: &str) -> Result<Vec<Operation>> {
        if !shufang_domain::sync::ENTITY_KINDS.contains(&kind) {
            return Err("invalid_kind".into());
        }
        self.repository.entity_history(kind, id)
    }
    pub fn restore_replica_entity(
        &mut self,
        kind: &str,
        source: &str,
        id: &str,
        operation_id: &str,
    ) -> Result<(bool, u64)> {
        if !shufang_domain::sync::valid_identifier(id)
            || !shufang_domain::sync::valid_identifier(operation_id)
        {
            return Err("invalid_identifier".into());
        }
        if source == id {
            return Err("restore_requires_new_entity_id".into());
        }
        let state = self
            .repository
            .load(kind, source)?
            .ok_or("entity_not_found")?
            .state;
        if state.kind == "reviews" {
            return Err("review_events_are_immutable".into());
        }
        if let Some(prior) = self.repository.operation(operation_id)? {
            if prior.kind != kind || prior.entity_id != id {
                return Err("operation_id_reused".into());
            }
            return Ok((
                true,
                self.repository
                    .operation_sequence(operation_id)?
                    .ok_or("operation_not_persisted")?,
            ));
        }
        let clock = self.repository.clock()?;
        let operation = Operation {
            workspace_id: self.workspace.clone(),
            replica_id: self.replica.clone(),
            operation_id: operation_id.into(),
            kind: kind.into(),
            entity_id: id.into(),
            clock: shufang_domain::sync::next_clock(&clock, self.runtime.now())?,
            patch: state
                .fields
                .into_iter()
                .filter(|(_, f)| !f.removed)
                .filter_map(|(k, f)| f.value.map(|v| (k, v)))
                .collect(),
            unset: vec![],
            deleted: false,
        };
        validate_operation(&operation)?;
        let prior = self.repository.load(kind, id)?;
        let expected = prior.as_ref().map_or(0, |p| p.revision);
        let next = apply_operation(prior.as_ref().map(|p| &p.state), &operation)?;
        self.repository.commit_batch(
            &clock,
            &[Commit {
                expected,
                state: next,
                operation,
            }],
        )?;
        Ok((
            false,
            self.repository
                .operation_sequence(operation_id)?
                .ok_or("operation_not_persisted")?,
        ))
    }
    pub fn sync_checkpoint(&self, key: &str) -> Result<(u64, serde_json::Value)> {
        if !key.starts_with("sync:") || key.len() > 256 {
            return Err("invalid_sync_key".into());
        }
        Ok(self
            .repository
            .get_local(key)?
            .unwrap_or((0, serde_json::Value::Null)))
    }
    pub fn acknowledge_sync(
        &mut self,
        key: &str,
        expected: u64,
        rows: &[LogOperation],
        receipts: &serde_json::Value,
    ) -> Result<()> {
        crate::sync_receipts::validate_sync_receipts(
            &rows
                .iter()
                .map(|row| row.operation.operation_id.clone())
                .collect::<Vec<_>>(),
            receipts,
        )?;
        if let Some(last) = rows.last() {
            self.repository.set_local(
                key,
                expected,
                &serde_json::Value::String(last.sequence.to_string()),
            )?;
        }
        Ok(())
    }
    pub fn replication_head(&self) -> Result<ReplicationHead> {
        self.repository.replication_head()
    }
    pub fn replication_operations(&self, after: u64, limit: u32) -> Result<Vec<LogOperation>> {
        self.repository.replication_operations(after, limit)
    }
    pub fn replication_operation_sequence(&self, id: &str) -> Result<Option<u64>> {
        self.repository.operation_sequence(id)
    }
    pub fn replication_operation(&self, id: &str) -> Result<Option<Operation>> {
        self.repository.operation(id)
    }
    pub fn replication_entities(
        &self,
        kind: Option<&str>,
        after: &str,
    ) -> Result<Vec<shufang_domain::sync::EntityState>> {
        if kind.is_some_and(|k| !shufang_domain::sync::ENTITY_KINDS.contains(&k))
            || after.len() > 256
        {
            return Err("invalid_entity_query".into());
        }
        self.repository.replication_entities(kind, after)
    }
    pub fn create_sync_snapshot(
        &mut self,
        id: &str,
        checkpoint: &str,
        sequence: u64,
    ) -> Result<()> {
        if !shufang_domain::sync::valid_identifier(id) {
            return Err("invalid_snapshot_id".into());
        }
        self.repository
            .create_snapshot(id, checkpoint, sequence, self.runtime.now())
    }
    pub fn sync_snapshot_page(
        &self,
        id: &str,
        after: &str,
    ) -> Result<(String, Vec<shufang_domain::sync::EntityState>)> {
        if !shufang_domain::sync::valid_identifier(id) || after.len() > 256 {
            return Err("invalid_snapshot_query".into());
        }
        self.repository.snapshot_page(id, after)
    }
    /// Application decides merges; adapter commits state, log and checkpoint together.
    pub fn receive_operations(
        &mut self,
        operations: &[Operation],
        checkpoint: Option<LocalCommit>,
    ) -> Result<Vec<bool>> {
        if operations.len() > 100 {
            return Err("invalid_batch".into());
        }
        let clock = self.repository.clock()?;
        let mut states: BTreeMap<(String, String), StoredEntity> = BTreeMap::new();
        let mut seen: BTreeMap<String, Operation> = BTreeMap::new();
        let mut commits = Vec::new();
        let mut duplicates = Vec::new();
        for op in operations {
            validate_operation(op)?;
            shufang_domain::sync_validation::validate_patch(op)?;
            if op.workspace_id != self.workspace {
                return Err("workspace_identity_mismatch".into());
            }
            let previous = match seen.get(&op.operation_id) {
                Some(v) => Some(v.clone()),
                None => self.repository.operation(&op.operation_id)?,
            };
            if let Some(previous) = previous {
                if !shufang_domain::sync::equivalent_operation(&previous, op) {
                    return Err("operation_id_reused".into());
                }
                duplicates.push(true);
                continue;
            }
            let key = (op.kind.clone(), op.entity_id.clone());
            let prior = match states.get(&key) {
                Some(v) => Some(v.clone()),
                None => self.repository.load(&op.kind, &op.entity_id)?,
            };
            let expected = prior.as_ref().map_or(0, |v| v.revision);
            if op.kind == "reviews"
                && (op.deleted
                    || !op.unset.is_empty()
                    || op.entity_id != op.operation_id
                    || prior.is_some())
            {
                return Err("review_events_are_immutable".into());
            }
            let state = apply_operation(prior.as_ref().map(|v| &v.state), op)?;
            commits.push(Commit {
                expected,
                state: state.clone(),
                operation: op.clone(),
            });
            states.insert(
                key,
                StoredEntity {
                    revision: expected.checked_add(1).ok_or("revision_overflow")?,
                    state,
                },
            );
            seen.insert(op.operation_id.clone(), op.clone());
            duplicates.push(false);
        }
        if !commits.is_empty() || checkpoint.is_some() {
            self.repository
                .receive_batch(&clock, &commits, checkpoint.as_ref())?;
        }
        Ok(duplicates)
    }
}
