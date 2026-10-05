//! Lossless repository contract. Network and UI adapters never decide field
//! conflicts or convert publisher-supplied strings into Unicode scalar values.
use crate::{LocalCommit, Result, Runtime};
use shufang_domain::lossless_sync::{ReplicaOperation, ReplicaState};
use std::collections::BTreeMap;
#[derive(Clone, Debug)]
pub struct StoredReplica {
    pub revision: u64,
    pub state: ReplicaState,
}
#[derive(Clone, Debug)]
pub struct ReplicaCommit {
    pub expected: u64,
    pub state: ReplicaState,
    pub operation: ReplicaOperation,
}
pub trait ReplicaRepository {
    fn replica_clock(&self) -> Result<String>;
    fn load_replica(&self, kind: &str, id: &str) -> Result<Option<StoredReplica>>;
    fn replica_operation(&self, id: &str) -> Result<Option<ReplicaOperation>>;
    fn receive_replica_batch(
        &mut self,
        expected_clock: &str,
        commits: &[ReplicaCommit],
        checkpoint: Option<&LocalCommit>,
    ) -> Result<()>;
}
pub struct ReplicaSession<R, T> {
    pub repository: R,
    pub runtime: T,
    workspace: String,
}
impl<R: ReplicaRepository, T: Runtime> ReplicaSession<R, T> {
    pub fn new(repository: R, runtime: T, workspace: String) -> Result<Self> {
        if !shufang_domain::sync::valid_identifier(&workspace) {
            return Err("invalid_identity".into());
        }
        Ok(Self {
            repository,
            runtime,
            workspace,
        })
    }
    pub fn receive(
        &mut self,
        operations: &[ReplicaOperation],
        checkpoint: Option<LocalCommit>,
    ) -> Result<Vec<bool>> {
        if operations.len() > 100 {
            return Err("invalid_batch".into());
        }
        let clock = self.repository.replica_clock()?;
        let mut seen: BTreeMap<String, ReplicaOperation> = BTreeMap::new();
        let mut states: BTreeMap<(String, String), StoredReplica> = BTreeMap::new();
        let mut commits = Vec::new();
        let mut duplicates = Vec::new();
        for op in operations {
            op.validate()?;
            shufang_domain::sync::validate_received_clock(&op.clock, self.runtime.now())?;
            if op.workspace_id != self.workspace {
                return Err("workspace_identity_mismatch".into());
            }
            let prior = seen
                .get(&op.operation_id)
                .cloned()
                .or(self.repository.replica_operation(&op.operation_id)?);
            if let Some(prior) = prior {
                if prior != *op {
                    return Err("operation_id_reused".into());
                }
                duplicates.push(true);
                continue;
            }
            let key = (op.kind.clone(), op.entity_id.clone());
            let prior = match states.get(&key) {
                Some(v) => Some(v.clone()),
                None => self.repository.load_replica(&op.kind, &op.entity_id)?,
            };
            if op.kind == "reviews"
                && (op.entity_id != op.operation_id
                    || op.deleted
                    || !op.unset.is_empty()
                    || prior.is_some())
            {
                return Err("review_events_are_immutable".into());
            }
            let expected = prior.as_ref().map_or(0, |v: &StoredReplica| v.revision);
            let state = ReplicaState::apply(prior.as_ref().map(|v| &v.state), op)?;
            commits.push(ReplicaCommit {
                expected,
                state: state.clone(),
                operation: op.clone(),
            });
            states.insert(
                key,
                StoredReplica {
                    revision: expected.checked_add(1).ok_or("revision_overflow")?,
                    state,
                },
            );
            seen.insert(op.operation_id.clone(), op.clone());
            duplicates.push(false);
        }
        if !commits.is_empty() || checkpoint.is_some() {
            self.repository
                .receive_replica_batch(&clock, &commits, checkpoint.as_ref())?;
        }
        Ok(duplicates)
    }
}
