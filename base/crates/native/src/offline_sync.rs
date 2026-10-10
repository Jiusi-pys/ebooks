//! Read-before-write guard. Server conditions close the gap after preflight.
use crate::{
    replication::{json_response, Peer},
    transport_host::SyncHost,
    workspace::{Result, Workspace},
};
use serde_json::{json, Value};
use shufang_domain::sync::{EntityState, Operation};
use std::{fs::File, sync::Arc};

pub fn fence(workspace: &Workspace) -> Result<File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(workspace.root.join("sync-conflict.lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| "sync_conflict_busy")?;
    Ok(file)
}
async fn preflight(
    client: &reqwest::Client,
    peer: &Peer,
    workspace: &str,
    op: &Operation,
) -> Result<Value> {
    let response = json_response(
        client
            .post(format!(
                "{}/api/v2/sync/preflight",
                peer.url.trim_end_matches('/')
            ))
            .headers(peer.headers())
            .header("X-Workspace-Id", workspace)
            .json(&json!({"operations":[op]}))
            .send()
            .await
            .map_err(|_| "sync_preflight_failed")?,
    )
    .await?;
    let entries = response["entries"]
        .as_array()
        .filter(|r| r.len() == 1)
        .ok_or("invalid_sync_preflight")?;
    let entry = &entries[0];
    if entry["operationId"] != op.operation_id
        || !entry["duplicate"].is_boolean()
        || entry.get("state").is_none()
    {
        return Err("invalid_sync_preflight".into());
    }
    Ok(entry.clone())
}
fn remote(entry: &Value, op: &Operation) -> Result<Option<EntityState>> {
    let remote: Option<EntityState> =
        serde_json::from_value(entry["state"].clone()).map_err(|_| "invalid_sync_preflight")?;
    if remote
        .as_ref()
        .is_some_and(|r| r.id != op.entity_id || r.kind != op.kind)
    {
        return Err("invalid_sync_preflight".into());
    }
    Ok(remote)
}
async fn cache_conflict(
    host: &Arc<SyncHost>,
    peer: &Peer,
    client: &reqwest::Client,
    workspace: &str,
    remote: &Option<EntityState>,
) -> Result<()> {
    let store = crate::sync_blobs::BlobStore::new(&host.workspace.root.join("sync-blobs"));
    if let Some(remote) = remote {
        let data = shufang_domain::sync::materialize(remote)?.unwrap_or(json!({}));
        for manifest in crate::attachments::references(&data)? {
            if !store.has(&manifest.sha256)? {
                crate::replication_files::download(
                    host, peer, client, workspace, &store, &manifest,
                )
                .await?;
            }
        }
    }
    Ok(())
}
pub async fn send_guarded(
    host: &Arc<SyncHost>,
    peer: &Peer,
    client: &reqwest::Client,
    workspace: &str,
    identity: &str,
) -> Result<()> {
    let send_key = format!("sync:send:{identity}");
    // Accepted operations rebase the journal but cannot skip earlier log entries.
    let mut after = host
        .workspace
        .core
        .lock()
        .map_err(|_| "core_lock_failed")?
        .sync_checkpoint(&send_key)?
        .1
        .as_str()
        .unwrap_or("0")
        .parse()
        .map_err(|_| "invalid_sync_checkpoint")?;
    loop {
        let rows = host
            .workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .replication_operations(after, 100)?;
        for row in &rows {
            if host
                .workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .operation_withdrawn(&row.operation.operation_id)?
            {
                continue;
            }
            let entry = preflight(client, peer, workspace, &row.operation).await?;
            let remote = remote(&entry, &row.operation)?;
            let conflict = {
                let mut core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
                if entry["duplicate"] == true {
                    core.recognize_received_sync_edit(&row.operation)?;
                    None
                } else {
                    core.inspect_sync_conflict(identity, &row.operation, remote.as_ref())?
                }
            };
            if conflict.is_some() {
                cache_conflict(host, peer, client, workspace, &remote).await?;
            }
        }
        if rows.len() < 100 {
            break;
        }
        after = rows.last().ok_or("sync_queue_stalled")?.sequence;
    }
    if !host
        .workspace
        .core
        .lock()
        .map_err(|_| "core_lock_failed")?
        .sync_conflicts()?
        .is_empty()
    {
        return Err("sync_conflicts_pending".into());
    }
    crate::replication_files::transfer(host, peer, client, workspace, identity).await?;
    for _ in 0..10000 {
        let (revision, row) = {
            let core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
            let (revision, position) = core.sync_checkpoint(&send_key)?;
            let after = position
                .as_str()
                .unwrap_or("0")
                .parse()
                .map_err(|_| "invalid_sync_checkpoint")?;
            (
                revision,
                core.replication_operations(after, 1)?.into_iter().next(),
            )
        };
        let Some(row) = row else { return Ok(()) };
        if host
            .workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .operation_withdrawn(&row.operation.operation_id)?
        {
            host.workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .advance_withdrawn_sync(&send_key, revision, &row)?;
            continue;
        }
        let entry = preflight(client, peer, workspace, &row.operation).await?;
        let remote = remote(&entry, &row.operation)?;
        if entry["duplicate"] != true {
            let conflict = host
                .workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .inspect_sync_conflict(identity, &row.operation, remote.as_ref())?;
            if conflict.is_some() {
                cache_conflict(host, peer, client, workspace, &remote).await?;
                return Err("sync_conflicts_pending".into());
            }
        }
        let payload = json!({"operations":[row.operation],"expectedEntities":[{"operationId":row.operation.operation_id,"state":remote}]});
        let reply = json_response(
            client
                .post(format!(
                    "{}/api/v2/sync/push",
                    peer.url.trim_end_matches('/')
                ))
                .headers(peer.headers())
                .header("X-Workspace-Id", workspace)
                .json(&payload)
                .send()
                .await
                .map_err(|_| "sync_send_failed")?,
        )
        .await?;
        if reply["receipts"][0]["error"] == "sync_precondition_failed" {
            return Err("sync_local_edits_pending".into());
        }
        host.workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .acknowledge_guarded_sync(&send_key, revision, &row, &reply["receipts"])?;
    }
    Err("sync_queue_not_drained".into())
}

pub fn command(workspace: &Arc<Workspace>, action: &str, args: &Value) -> Result<Value> {
    match action {
        "enableSyncConflicts" => {
            workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .enable_sync_conflicts()?;
            Ok(json!({"enabled":true}))
        }
        "syncConflicts" => {
            let rows = workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .sync_conflicts()?;
            Ok(json!(rows.into_iter().map(|r|json!({"id":r["id"],"kind":r["kind"],"entityId":r["entityId"],"fingerprint":r["fingerprint"],"legacy":r["legacy"],"localDeleted":r["localState"]["deleted"],"remoteDeleted":r["remoteState"]["deleted"]})).collect::<Vec<_>>()))
        }
        "syncConflictPreview" => {
            let core = workspace.core.lock().map_err(|_| "core_lock_failed")?;
            let record = core
                .sync_conflicts()?
                .into_iter()
                .find(|r| r["id"] == args["id"])
                .ok_or("sync_conflict_not_found")?;
            let mut result = record.clone();
            for key in ["localState", "remoteState"] {
                let state: Option<EntityState> = serde_json::from_value(record[key].clone())
                    .map_err(|_| "invalid_sync_conflict")?;
                let materialized = state
                    .as_ref()
                    .filter(|s| !s.deleted)
                    .map(|s| core.materialize_sync_conflict(s))
                    .transpose()?
                    .flatten();
                result[if key == "localState" {
                    "local"
                } else {
                    "remote"
                }] = materialized.unwrap_or(Value::Null);
            }
            let path = workspace
                .root
                .join(format!("conflict-preview-{}.json", uuid::Uuid::new_v4()));
            std::fs::write(&path, result.to_string()).map_err(|e| e.to_string())?;
            Ok(json!({"path":path}))
        }
        "resolveSyncConflict" => {
            let _fence = fence(workspace)?;
            workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .resolve_sync_conflict(
                    crate::workspace::string(args, "id")?,
                    crate::workspace::string(args, "fingerprint")?,
                    crate::workspace::string(args, "choice")?,
                )
        }
        _ => Err("unknown_command".into()),
    }
}
