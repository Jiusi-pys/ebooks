//! Network adapter: core owns staging, state merge and atomic watermark commit.
use crate::{
    replication::{json_response, Peer},
    transport_host::SyncHost as Host,
};
use serde_json::json;
use shufang_application::{
    incoming_snapshot::{IncomingSnapshot, SnapshotPage},
    LocalCommit, Runtime,
};
use shufang_domain::{lossless_json::Json, lossless_sync::ReplicaState};
use std::sync::Arc;
fn text(value: &Json, key: &str) -> Result<String, String> {
    let text = value
        .get(key)
        .ok_or("invalid_snapshot_response")?
        .to_owned();
    String::from_utf16(text.string_units().ok_or("invalid_snapshot_response")?)
        .map_err(|_| "invalid_snapshot_response".into())
}
pub async fn restore(
    host: &Arc<Host>,
    peer: &Peer,
    client: &reqwest::Client,
    workspace: &str,
    identity: &str,
    epoch: &str,
    force: bool,
) -> Result<(), String> {
    let receive_key = format!("sync:receive:{identity}");
    let age_key = format!("sync:snapshot-at:{identity}");
    let now = crate::workspace::SystemRuntime.now();
    let (revision, position, age, mut snapshot) = {
        let core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
        let (revision, position) = core.sync_checkpoint(&receive_key)?;
        let (_, age) = core.sync_checkpoint(&age_key)?;
        (revision, position, age, core.incoming_snapshot(identity)?)
    };
    if !force
        && snapshot.is_none()
        && position.is_string()
        && age
            .as_u64()
            .is_some_and(|age| now.saturating_sub(age) < 300000)
    {
        return Ok(());
    }
    if snapshot.is_none() {
        let created = json_response(
            client
                .post(format!(
                    "{}/api/v2/sync/snapshots",
                    peer.url.trim_end_matches('/')
                ))
                .headers(peer.headers())
                .header("X-Workspace-Id", workspace)
                .send()
                .await
                .map_err(|_| "sync_snapshot_connect_failed")?,
        )
        .await?;
        let id = created["id"].as_str().ok_or("invalid_snapshot_response")?;
        let cursor = created["cursor"]
            .as_str()
            .ok_or("invalid_snapshot_response")?;
        let mut created = IncomingSnapshot::new(identity, id, epoch, cursor, now)?;
        created.receive_revision = Some(revision);
        host.workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .begin_incoming_snapshot(&created)?;
        snapshot = Some(created);
    }
    let mut snapshot = snapshot.ok_or("snapshot_not_found")?;
    while let Some(after) = snapshot.next.clone() {
        let mut response = client
            .get(format!(
                "{}/api/v2/sync/snapshots/{}",
                peer.url.trim_end_matches('/'),
                snapshot.id
            ))
            .query(&[("after", after.as_str())])
            .headers(peer.headers())
            .header("X-Workspace-Id", workspace)
            .send()
            .await
            .map_err(|_| "sync_snapshot_connect_failed")?;
        if matches!(response.status().as_u16(), 404 | 410) {
            host.workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .abandon_incoming_snapshot(identity, &snapshot.id)?;
            return Err("sync_snapshot_expired".into());
        }
        if !response.status().is_success() {
            return Err(format!("sync_http_{}", response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > 16 * 1024 * 1024)
        {
            return Err("sync_snapshot_response_too_large".into());
        }
        let mut bytes = Vec::new();
        while let Some(part) = response
            .chunk()
            .await
            .map_err(|_| "sync_snapshot_read_failed")?
        {
            if bytes.len() + part.len() > 16 * 1024 * 1024 {
                return Err("sync_snapshot_response_too_large".into());
            }
            bytes.extend_from_slice(&part);
        }
        let value = Json::parse(std::str::from_utf8(&bytes).map_err(|_| "invalid_snapshot_utf8")?)?;
        if text(&value, "cursor")? != snapshot.watermark {
            return Err("snapshot_watermark_changed".into());
        }
        let next = value
            .get("next")
            .ok_or("invalid_snapshot_response")?
            .to_owned();
        let next = if next.is_null() {
            None
        } else {
            Some(text(&value, "next")?)
        };
        let states = value
            .get("entities")
            .ok_or("invalid_snapshot_response")?
            .to_owned()
            .elements()
            .ok_or("invalid_snapshot_response")?
            .iter()
            .map(|value| ReplicaState::parse(&value.stringify(false)))
            .collect::<Result<Vec<_>, _>>()?;
        host.workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .stage_incoming_snapshot(
                identity,
                &snapshot.id,
                &SnapshotPage {
                    index: snapshot.pages,
                    after,
                    next: next.clone(),
                    states,
                },
            )?;
        snapshot.pages += 1;
        snapshot.next = next;
    }
    let mut core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
    if core.sync_conflicts_enabled()?
        && core.has_unsent_local_edits(&format!("sync:send:{identity}"))?
    {
        return Err("sync_local_edits_pending".into());
    }
    core.finish_incoming_snapshot(
        identity,
        &snapshot.id,
        &LocalCommit {
            key: receive_key,
            expected: snapshot.receive_revision.unwrap_or(revision),
            value: json!(snapshot.watermark),
        },
    )?;
    let (revision, _) = core.sync_checkpoint(&age_key)?;
    core.set_local_value(&age_key, revision, &json!(now))?;
    Ok(())
}
