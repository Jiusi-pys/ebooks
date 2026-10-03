//! Offline restore rehearsal. Never opens or replaces the source library.
use serde::Deserialize;
use serde_json::json;
use shufang_application::{
    incoming_snapshot::{IncomingSnapshot, SnapshotPage, SnapshotRepository},
    replica::{ReplicaRepository, ReplicaSession},
    LocalCommit, ReplicationRepository,
};
use shufang_domain::lossless_sync::{ReplicaOperation, ReplicaState};
use shufang_native::workspace::SystemRuntime;
use shufang_sqlite::SqliteRepository;
use std::{collections::BTreeSet, io::BufRead, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    r#type: String,
    json: String,
}
fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: rehearse_library export.ndjson new.sqlite3 workspace".into());
    }
    let target = PathBuf::from(&args[2]);
    if target.exists() {
        return Err("restore_destination_exists".into());
    }
    let source = std::fs::File::open(&args[1]).map_err(|_| "export_read_failed")?;
    if source.metadata().map_err(|_| "export_read_failed")?.len() > 256 * 1024 * 1024 {
        return Err("export_too_large".into());
    }
    let mut states = Vec::new();
    let mut operations = Vec::new();
    let mut state_ids = BTreeSet::new();
    let mut operation_ids = BTreeSet::new();
    for line in std::io::BufReader::new(source).lines() {
        let row: Row = serde_json::from_str(&line.map_err(|_| "export_read_failed")?)
            .map_err(|_| "invalid_export")?;
        match row.r#type.as_str() {
            "state" => {
                let state = ReplicaState::parse(&row.json)?;
                if !state_ids.insert((state.kind.clone(), state.id.clone())) {
                    return Err("duplicate_export_state".into());
                }
                states.push(state);
            }
            "operation" => {
                let op = ReplicaOperation::parse(&row.json)?;
                if op.workspace_id != args[3] || !operation_ids.insert(op.operation_id.clone()) {
                    return Err("invalid_export_operation_identity".into());
                }
                operations.push(op);
            }
            _ => return Err("invalid_export_row".into()),
        }
    }
    // Validate the entire export before creating the independent destination.
    let repository = SqliteRepository::open(&target, &args[3], "offline-rehearsal")?;
    let mut session = ReplicaSession::new(repository, SystemRuntime, args[3].clone())?;
    for batch in operations.chunks(100) {
        session.receive(batch, None)?;
        if session
            .receive(batch, None)?
            .iter()
            .any(|duplicate| !duplicate)
        {
            return Err("replay_not_idempotent".into());
        }
    }
    let mut repository = session.repository;
    repository.begin_snapshot(&IncomingSnapshot::new(
        "offline-rehearsal",
        "backup",
        "backup",
        "offline-backup",
        1,
    )?)?;
    let pages = states.len().div_ceil(100).max(1);
    for index in 0..pages {
        let start = index * 100;
        repository.stage_snapshot_page(
            "offline-rehearsal",
            "backup",
            &SnapshotPage {
                index: index as u32,
                after: if index == 0 {
                    String::new()
                } else {
                    index.to_string()
                },
                next: (index + 1 < pages).then(|| (index + 1).to_string()),
                states: states[start..states.len().min(start + 100)].to_vec(),
            },
        )?;
    }
    repository.finish_snapshot(
        "offline-rehearsal",
        "backup",
        &LocalCommit {
            key: "sync:rehearsal:cursor".into(),
            expected: 0,
            value: json!("offline-backup"),
        },
    )?;
    drop(repository);
    let repository = SqliteRepository::open(&target, &args[3], "offline-rehearsal")?;
    for state in &states {
        if repository
            .load_replica(&state.kind, &state.id)?
            .ok_or("restored_state_missing")?
            .state
            != *state
        {
            return Err("restored_state_mismatch".into());
        }
    }
    for op in &operations {
        if repository.replica_operation(&op.operation_id)?.as_ref() != Some(op) {
            return Err("restored_original_operation_mismatch".into());
        }
    }
    if repository.replication_head()?.sequence != operations.len().to_string() {
        return Err("restored_log_length_mismatch".into());
    }
    println!(
        "PASS: {} states, {} original operations, replay and restart",
        states.len(),
        operations.len()
    );
    Ok(())
}
