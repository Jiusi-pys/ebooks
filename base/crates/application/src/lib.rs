//! Use cases depend on ports, never on a database or a view framework.
mod blobs;
pub mod externalize;
mod field_storage;
pub mod folder_deletion;
pub mod incoming_snapshot;
mod library;
mod offline_conflicts;
mod offline_copy;
mod outline;
pub mod record_drafts;
pub mod recovery;
pub mod replica;
mod replication;
pub mod sync_receipts;
pub use blobs::{BlobManifest, CHUNK_SIZE, MAX_BLOB_SIZE};
pub use library::Record;
pub use replication::{retry_delay, LogOperation, ReplicationHead, ReplicationRepository};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shufang_domain::sync::{apply_operation, next_clock, valid_identifier, EntityState, Operation};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredEntity {
    pub revision: u64,
    pub state: EntityState,
}

#[derive(Clone, Debug)]
pub struct Commit {
    pub expected: u64,
    pub state: EntityState,
    pub operation: Operation,
}
#[derive(Clone, Debug)]
pub struct LocalCommit {
    pub key: String,
    pub expected: u64,
    pub value: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Change {
    pub sequence: u64,
    pub kind: String,
    pub id: String,
    pub revision: u64,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Value>,
}

/// A commit must atomically check the revision, write the state, append the
/// operation to the outbox, and advance the local clock. No network I/O here.
pub trait Repository {
    /// Explicitly discard an unreceived local projection using a persisted preview.
    /// Adapters must validate the preview inside the same transaction as the decision.
    fn commit_sync_resolution(
        &mut self,
        _clock: &str,
        _commits: &[Commit],
        _locals: &[LocalCommit],
        _id: &str,
        _fingerprint: &str,
    ) -> Result<()> {
        Err("sync_resolution_adapter_unavailable".into())
    }
    fn load(&self, kind: &str, id: &str) -> Result<Option<StoredEntity>>;
    fn list(&self, kind: &str) -> Result<Vec<StoredEntity>>;
    fn clock(&self) -> Result<String>;
    fn commit(&mut self, expected: u64, state: &EntityState, operation: &Operation) -> Result<()>;
    fn pending(&self) -> Result<Vec<Operation>>;
    fn commit_batch(&mut self, expected_clock: &str, commits: &[Commit]) -> Result<()>;
    fn commit_batch_local(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
        locals: &[LocalCommit],
    ) -> Result<()>;
    fn changes(&self, after: u64, limit: u32) -> Result<Vec<Change>>;
    fn get_local(&self, key: &str) -> Result<Option<(u64, Value)>>;
    fn set_local(&mut self, key: &str, expected: u64, value: &Value) -> Result<u64>;
    fn local_usage(&self, prefix: &str) -> Result<(u64, u64)>;
    fn delete_expired_local(&mut self, prefix: &str, now: u64, limit: u32) -> Result<u64>;
}

pub trait Runtime {
    fn now(&self) -> u64;
    fn new_id(&self) -> String;
}

pub struct CoreSession<R, T> {
    repository: R,
    runtime: T,
    workspace: String,
    replica: String,
    pending_local: Option<Vec<LocalCommit>>,
    receipt_scope: bool,
    field_storage: Option<Box<dyn externalize::FieldStorage>>,
}

impl<R: Repository, T: Runtime> CoreSession<R, T> {
    pub fn repository(&self) -> &R {
        &self.repository
    }
    pub fn repository_mut(&mut self) -> &mut R {
        &mut self.repository
    }
    pub fn new(repository: R, runtime: T, workspace: String, replica: String) -> Result<Self> {
        if !valid_identifier(&workspace) || !valid_identifier(&replica) {
            return Err("invalid_identity".into());
        }
        Ok(Self {
            repository,
            runtime,
            workspace,
            replica,
            pending_local: None,
            receipt_scope: false,
            field_storage: None,
        })
    }
    /// Receipt and mutation commit together. Exactly one transaction per action.
    pub fn with_receipt<F>(
        &mut self,
        key: &str,
        fingerprint: &str,
        mut extra: Vec<LocalCommit>,
        action: F,
    ) -> Result<bool>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        if self.receipt_scope {
            return Err("nested_receipt".into());
        }
        if let Some((_, value)) = self.repository.get_local(key)? {
            return if value["fingerprint"] == fingerprint {
                Ok(true)
            } else {
                Err("delivery_conflict".into())
            };
        }
        extra.push(LocalCommit {
            key: key.into(),
            expected: 0,
            value: json!({"version":1,"fingerprint":fingerprint,"expires":self.runtime.now().saturating_add(7*86_400_000)}),
        });
        self.pending_local = Some(extra);
        self.receipt_scope = true;
        let result = action(self);
        let uncommitted = self.pending_local.take().is_some();
        self.receipt_scope = false;
        result?;
        if uncommitted {
            return Err("receipt_without_commit".into());
        }
        Ok(false)
    }
    pub fn commit_receipt(&mut self) -> Result<()> {
        let locals = self.pending_local.take().ok_or("receipt_without_scope")?;
        self.repository
            .commit_batch_local(&self.repository.clock()?, &[], &locals)
    }
    pub fn notes(&self) -> Result<Vec<Value>> {
        let mut notes = Vec::new();
        for row in self.repository.list("notes")? {
            if let Some(note) = self.materialize_state(&row.state)? {
                notes.push(json!({"revision":row.revision,"note":note}));
            }
        }
        Ok(notes)
    }
    pub fn save_note(
        &mut self,
        id: &str,
        title: &str,
        content: &str,
        expected: u64,
    ) -> Result<Value> {
        if title.trim().is_empty()
            || title.chars().count() > 1000
            || content.len() > 4 * 1024 * 1024
        {
            return Err("invalid_note".into());
        }
        let prior = self.repository.load("notes", id)?;
        if prior.as_ref().map_or(0, |p| p.revision) != expected {
            return Err("revision_conflict".into());
        }
        if prior.as_ref().is_some_and(|p| p.state.deleted) {
            return Err("entity_deleted".into());
        }
        if let Some(prior) = &prior {
            self.materialize_state(&prior.state)?;
        }
        let now = self.runtime.now();
        let mut patch = json!({"title":title,"content":content,"updatedAt":now})
            .as_object()
            .unwrap()
            .clone();
        if prior.is_none() {
            patch.insert("createdAt".into(), now.into());
        }
        let patch = self.prepare_patch(patch)?;
        let operation = Operation {
            workspace_id: self.workspace.clone(),
            operation_id: self.runtime.new_id(),
            replica_id: self.replica.clone(),
            kind: "notes".into(),
            entity_id: id.into(),
            clock: next_clock(&self.repository.clock()?, now)?,
            patch,
            unset: vec![],
            deleted: false,
        };
        let state = apply_operation(prior.as_ref().map(|p| &p.state), &operation)?;
        self.repository.commit(expected, &state, &operation)?;
        Ok(json!({"revision":expected+1,"note":self.materialize_state(&state)?}))
    }
    pub fn pending(&self) -> Result<Vec<Operation>> {
        self.repository.pending()
    }
}
