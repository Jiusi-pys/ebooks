//! Selects an adapter; commands never switch to a SQLite cache for MySQL writes.
use serde_json::Value;
use shufang_application::incoming_snapshot::{IncomingSnapshot, SnapshotPage, SnapshotRepository};
use shufang_application::{
    Change, Commit, LocalCommit, LogOperation, ReplicationHead, ReplicationRepository, Repository,
    Result, StoredEntity,
};
use shufang_domain::sync::{EntityState, Operation};
pub enum Storage {
    Sqlite(shufang_sqlite::SqliteRepository),
    #[cfg(feature = "server-mysql")]
    Mysql(shufang_mysql::MysqlRepository),
}

impl Repository for Storage {
    fn commit_sync_resolution(&mut self, clock:&str, commits:&[Commit], locals:&[LocalCommit], id:&str, fingerprint:&str)->Result<()> {
        match self {
            Self::Sqlite(r)=>r.commit_sync_resolution(clock,commits,locals,id,fingerprint),
            #[cfg(feature="server-mysql")]
            Self::Mysql(r)=>r.commit_sync_resolution(clock,commits,locals,id,fingerprint),
        }
    }
    fn load(&self, kind: &str, id: &str) -> Result<Option<StoredEntity>> {
        match self {
            Self::Sqlite(r) => r.load(kind, id),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.load(kind, id),
        }
    }
    fn list(&self, kind: &str) -> Result<Vec<StoredEntity>> {
        match self {
            Self::Sqlite(r) => r.list(kind),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.list(kind),
        }
    }
    fn clock(&self) -> Result<String> {
        match self {
            Self::Sqlite(r) => r.clock(),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.clock(),
        }
    }
    fn commit(&mut self, expected: u64, state: &EntityState, operation: &Operation) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.commit(expected, state, operation),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.commit(expected, state, operation),
        }
    }
    fn pending(&self) -> Result<Vec<Operation>> {
        match self {
            Self::Sqlite(r) => r.pending(),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.pending(),
        }
    }
    fn commit_batch(&mut self, expected_clock: &str, commits: &[Commit]) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.commit_batch(expected_clock, commits),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.commit_batch(expected_clock, commits),
        }
    }
    fn commit_batch_local(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
        locals: &[LocalCommit],
    ) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.commit_batch_local(expected_clock, commits, locals),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.commit_batch_local(expected_clock, commits, locals),
        }
    }
    fn changes(&self, after: u64, limit: u32) -> Result<Vec<Change>> {
        match self {
            Self::Sqlite(r) => r.changes(after, limit),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.changes(after, limit),
        }
    }
    fn get_local(&self, key: &str) -> Result<Option<(u64, Value)>> {
        match self {
            Self::Sqlite(r) => r.get_local(key),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.get_local(key),
        }
    }
    fn set_local(&mut self, key: &str, expected: u64, value: &Value) -> Result<u64> {
        match self {
            Self::Sqlite(r) => r.set_local(key, expected, value),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.set_local(key, expected, value),
        }
    }
    fn local_usage(&self, prefix: &str) -> Result<(u64, u64)> {
        match self {
            Self::Sqlite(r) => r.local_usage(prefix),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.local_usage(prefix),
        }
    }
    fn delete_expired_local(&mut self, prefix: &str, now: u64, limit: u32) -> Result<u64> {
        match self {
            Self::Sqlite(r) => r.delete_expired_local(prefix, now, limit),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.delete_expired_local(prefix, now, limit),
        }
    }
}

impl ReplicationRepository for Storage {
    fn mutation_batch_local(
        &mut self,
        clock: &str,
        commits: &[Commit],
        locals: &[LocalCommit],
    ) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.mutation_batch_local(clock, commits, locals),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.mutation_batch_local(clock, commits, locals),
        }
    }

    fn mutation_batch(&mut self, expected_clock: &str, commits: &[Commit]) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.mutation_batch(expected_clock, commits),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.mutation_batch(expected_clock, commits),
        }
    }
    fn replication_head(&self) -> Result<ReplicationHead> {
        match self {
            Self::Sqlite(r) => r.replication_head(),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.replication_head(),
        }
    }
    fn operation(&self, id: &str) -> Result<Option<Operation>> {
        match self {
            Self::Sqlite(r) => r.operation(id),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.operation(id),
        }
    }
    fn operation_sequence(&self, id: &str) -> Result<Option<u64>> {
        match self {
            Self::Sqlite(r) => r.operation_sequence(id),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.operation_sequence(id),
        }
    }
    fn entity_history(&self, kind: &str, id: &str) -> Result<Vec<Operation>> {
        match self {
            Self::Sqlite(r) => r.entity_history(kind, id),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.entity_history(kind, id),
        }
    }
    fn replication_operations(&self, after: u64, limit: u32) -> Result<Vec<LogOperation>> {
        match self {
            Self::Sqlite(r) => r.replication_operations(after, limit),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.replication_operations(after, limit),
        }
    }
    fn receive_batch(
        &mut self,
        expected_clock: &str,
        commits: &[Commit],
        checkpoint: Option<&LocalCommit>,
    ) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.receive_batch(expected_clock, commits, checkpoint),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.receive_batch(expected_clock, commits, checkpoint),
        }
    }
    fn replication_entities(
        &self,
        kind: Option<&str>,
        after: &str,
    ) -> Result<Vec<shufang_domain::sync::EntityState>> {
        match self {
            Self::Sqlite(r) => r.replication_entities(kind, after),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.replication_entities(kind, after),
        }
    }
    fn create_snapshot(
        &mut self,
        id: &str,
        checkpoint: &str,
        expected_sequence: u64,
        now: u64,
    ) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.create_snapshot(id, checkpoint, expected_sequence, now),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.create_snapshot(id, checkpoint, expected_sequence, now),
        }
    }
    fn snapshot_page(
        &self,
        id: &str,
        after: &str,
    ) -> Result<(String, Vec<shufang_domain::sync::EntityState>)> {
        match self {
            Self::Sqlite(r) => r.snapshot_page(id, after),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.snapshot_page(id, after),
        }
    }
}

impl SnapshotRepository for Storage {
    fn incoming_snapshot(&self, peer: &str) -> Result<Option<IncomingSnapshot>> {
        match self {
            Self::Sqlite(r) => r.incoming_snapshot(peer),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.incoming_snapshot(peer),
        }
    }
    fn begin_snapshot(&mut self, snapshot: &IncomingSnapshot) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.begin_snapshot(snapshot),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.begin_snapshot(snapshot),
        }
    }
    fn stage_snapshot_page(&mut self, peer: &str, id: &str, page: &SnapshotPage) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.stage_snapshot_page(peer, id, page),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.stage_snapshot_page(peer, id, page),
        }
    }
    fn abandon_snapshot(&mut self, peer: &str, id: &str) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.abandon_snapshot(peer, id),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.abandon_snapshot(peer, id),
        }
    }
    fn finish_snapshot(&mut self, peer: &str, id: &str, checkpoint: &LocalCommit) -> Result<()> {
        match self {
            Self::Sqlite(r) => r.finish_snapshot(peer, id, checkpoint),
            #[cfg(feature = "server-mysql")]
            Self::Mysql(r) => r.finish_snapshot(peer, id, checkpoint),
        }
    }
}
