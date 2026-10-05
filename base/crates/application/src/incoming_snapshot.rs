//! Durable inbound snapshots are separate from the immutable operation log.
use crate::{LocalCommit, Result};
use serde::{Deserialize, Serialize};
use shufang_domain::{lossless_sync::ReplicaState, sync::valid_identifier};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IncomingSnapshot {
    pub version: u32,
    pub peer: String,
    pub id: String,
    pub epoch: String,
    pub watermark: String,
    pub created_at: u64,
    pub pages: u32,
    pub next: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receive_revision: Option<u64>,
}
impl IncomingSnapshot {
    pub fn new(peer: &str, id: &str, epoch: &str, watermark: &str, now: u64) -> Result<Self> {
        let snapshot = Self {
            version: 1,
            peer: peer.into(),
            id: id.into(),
            epoch: epoch.into(),
            watermark: watermark.into(),
            created_at: now,
            pages: 0,
            next: Some(String::new()),
            receive_revision: None,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || !valid_identifier(&self.peer)
            || !valid_identifier(&self.id)
            || !valid_identifier(&self.epoch)
            || self.watermark.is_empty()
            || self.watermark.len() > 4096
            || self.next.as_ref().is_some_and(|s| s.len() > 512)
            || self.pages > 100_000
        {
            return Err("invalid_snapshot".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotPage {
    pub index: u32,
    pub after: String,
    pub next: Option<String>,
    pub states: Vec<ReplicaState>,
}
impl SnapshotPage {
    pub fn validate(&self) -> Result<()> {
        if self.index >= 100_000
            || self.states.len() > 100
            || self.after.len() > 512
            || self
                .next
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 512 || s == &self.after)
        {
            return Err("invalid_snapshot_page".into());
        }
        let mut seen = BTreeSet::new();
        for state in &self.states {
            state.validate()?;
            if !seen.insert((&state.kind, &state.id)) {
                return Err("duplicate_snapshot_entity".into());
            }
        }
        Ok(())
    }
}
pub trait SnapshotRepository {
    fn incoming_snapshot(&self, peer: &str) -> Result<Option<IncomingSnapshot>>;
    fn begin_snapshot(&mut self, snapshot: &IncomingSnapshot) -> Result<()>;
    fn stage_snapshot_page(&mut self, peer: &str, id: &str, page: &SnapshotPage) -> Result<()>;
    /// Abandon only this incomplete download; never touch live entities or cursors.
    fn abandon_snapshot(&mut self, peer: &str, id: &str) -> Result<()>;
    /// Merge all verified pages, advance the watermark and remove staging atomically.
    /// Preserve local outbox; snapshots must never invent operations.
    fn finish_snapshot(&mut self, peer: &str, id: &str, checkpoint: &LocalCommit) -> Result<()>;
}

impl<R: crate::Repository + SnapshotRepository, T: crate::Runtime> crate::CoreSession<R, T> {
    pub fn incoming_snapshot(&self, peer: &str) -> Result<Option<IncomingSnapshot>> {
        self.repository.incoming_snapshot(peer)
    }
    pub fn begin_incoming_snapshot(&mut self, snapshot: &IncomingSnapshot) -> Result<()> {
        self.repository.begin_snapshot(snapshot)
    }
    pub fn stage_incoming_snapshot(
        &mut self,
        peer: &str,
        id: &str,
        page: &SnapshotPage,
    ) -> Result<()> {
        page.validate()?;
        for state in &page.states {
            for field in state.fields.values() {
                let clock = shufang_domain::lossless_sync::field_clock(&field.version)?;
                shufang_domain::sync::validate_received_clock(&clock, self.runtime.now())?;
            }
        }
        self.repository.stage_snapshot_page(peer, id, page)
    }
    pub fn finish_incoming_snapshot(
        &mut self,
        peer: &str,
        id: &str,
        checkpoint: &LocalCommit,
    ) -> Result<()> {
        self.repository.finish_snapshot(peer, id, checkpoint)
    }
    pub fn abandon_incoming_snapshot(&mut self, peer: &str, id: &str) -> Result<()> {
        self.repository.abandon_snapshot(peer, id)
    }
}
