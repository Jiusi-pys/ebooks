//! Reqwest transport adapter; shared core owns receipts and atomic checkpoints.
use crate::Host;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_application::LocalCommit;
use shufang_domain::sync::Operation;
use std::sync::Arc;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Peer {
    pub id: String,
    pub url: String,
    #[serde(skip_serializing)]
    pub token: String,
}
fn validate(peer: &Peer) -> Result<(), String> {
    if !shufang_domain::sync::valid_identifier(&peer.id) || peer.token.is_empty() {
        return Err("invalid_peer".into());
    }
    shufang_native::sync_config::validate_url(&peer.url)
}

pub(crate) async fn json_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("sync_http_{}", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|v| v > 2 * 1024 * 1024)
    {
        return Err("sync_response_too_large".into());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "sync_read_failed")? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("sync_response_too_large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_sync_response".into())
}
pub async fn tick_peer(host: &Arc<Host>, peer: &Peer) -> Result<(), String> {
    validate(peer)?;
    let workspace = host
        .workspace
        .core
        .lock()
        .map_err(|_| "core_lock_failed")?
        .replication_head()?
        .workspace_id;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "sync_client_failed")?;
    let request = |path: &str| {
        client
            .get(format!("{}/api/v2{path}", peer.url.trim_end_matches('/')))
            .bearer_auth(&peer.token)
            .header("X-Workspace-Id", &workspace)
    };
    let cap = json_response(
        request("/capabilities")
            .send()
            .await
            .map_err(|_| "sync_connect_failed")?,
    )
    .await?;
    let epoch = cap["epoch"]
        .as_str()
        .filter(|s| s.len() <= 128 && !s.is_empty())
        .ok_or("invalid_peer_capabilities")?;
    if cap["version"] != 2
        || cap["workspaceId"] != workspace
        || cap["nodeId"] != peer.id
        || cap["maxBatch"] != 100
        || cap["maxBytes"] != 1024 * 1024
        || cap["chunkSize"] != 256 * 1024
    {
        return Err("peer_capability_mismatch".into());
    }
    let identity = format!(
        "{:x}",
        Sha256::digest(json!([peer.id, peer.url, epoch]).to_string().as_bytes())
    );
    let send_key = format!("sync:send:{identity}");
    let receive_key = format!("sync:receive:{identity}");
    crate::incoming_snapshot::restore(host, peer, &client, &workspace, &identity, epoch, false)
        .await?;
    pull_history(host, peer, &client, &workspace, &identity).await?;
    let mut recovered = false;
    for _ in 0..100 {
        let (expected, mut rows) = {
            let c = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
            let (revision, position) = c.sync_checkpoint(&send_key)?;
            let after = position
                .as_str()
                .unwrap_or("0")
                .parse()
                .map_err(|_| "invalid_sync_checkpoint")?;
            (revision, c.replication_operations(after, 100)?)
        };
        if rows.is_empty() {
            break;
        }
        while serde_json::to_vec(
            &json!({"operations":rows.iter().map(|r|&r.operation).collect::<Vec<_>>()}),
        )
        .map_err(|_| "invalid_sync_request")?
        .len()
            > 1024 * 1024
        {
            if rows.len() == 1 {
                return Err("sync_operation_requires_blob".into());
            }
            rows.pop();
        }
        let payload = json!({"operations":rows.iter().map(|r|&r.operation).collect::<Vec<_>>()});
        let receipts = json_response(
            client
                .post(format!(
                    "{}/api/v2/sync/push",
                    peer.url.trim_end_matches('/')
                ))
                .bearer_auth(&peer.token)
                .header("X-Workspace-Id", &workspace)
                .json(&payload)
                .send()
                .await
                .map_err(|_| "sync_send_failed")?,
        )
        .await?;
        host.workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .acknowledge_sync(&send_key, expected, &rows, &receipts["receipts"])?;
    }
    for _ in 0..100 {
        let (expected, previous) = {
            host.workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .sync_checkpoint(&receive_key)?
        };
        let mut req = request("/sync/changes");
        if let Some(cursor) = previous.as_str() {
            req = req.query(&[("cursor", cursor)]);
        }
        let response = req.send().await.map_err(|_| "sync_receive_failed")?;
        if !recovered && matches!(response.status().as_u16(), 400 | 409) {
            crate::incoming_snapshot::restore(
                host, peer, &client, &workspace, &identity, epoch, true,
            )
            .await?;
            recovered = true;
            continue;
        }
        let page = json_response(response).await?;
        let operations: Vec<Operation> = serde_json::from_value(page["operations"].clone())
            .map_err(|_| "invalid_sync_operations")?;
        if operations.len() > 100 {
            return Err("invalid_sync_batch".into());
        }
        let cursor = page["cursor"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 2048)
            .ok_or("invalid_peer_cursor")?;
        let has_more = page["hasMore"].as_bool().ok_or("invalid_sync_response")?;
        if has_more && (operations.is_empty() || previous.as_str() == Some(cursor)) {
            return Err("sync_cursor_stalled".into());
        }
        host.workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .receive_operations(
                &operations,
                Some(LocalCommit {
                    key: receive_key.clone(),
                    expected,
                    value: json!(cursor),
                }),
            )?;
        if !has_more {
            break;
        }
    }
    crate::replication_files::transfer(host, peer, &client, &workspace, &identity).await?;
    Ok(())
}

async fn pull_history(
    host: &Arc<Host>,
    peer: &Peer,
    client: &reqwest::Client,
    workspace: &str,
    identity: &str,
) -> Result<(), String> {
    let key = format!("sync:history:{identity}");
    let complete_key = format!("sync:history-complete:{identity}");
    if host
        .workspace
        .core
        .lock()
        .map_err(|_| "core_lock_failed")?
        .sync_checkpoint(&complete_key)?
        .1
        == true
    {
        return Ok(());
    }
    for _ in 0..100 {
        let (expected, previous) = host
            .workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .sync_checkpoint(&key)?;
        let mut request = client
            .get(format!(
                "{}/api/v2/sync/changes",
                peer.url.trim_end_matches('/')
            ))
            .bearer_auth(&peer.token)
            .header("X-Workspace-Id", workspace);
        if let Some(cursor) = previous.as_str() {
            request = request.query(&[("cursor", cursor)]);
        }
        let page = json_response(
            request
                .send()
                .await
                .map_err(|_| "sync_history_connect_failed")?,
        )
        .await?;
        let operations: Vec<Operation> = serde_json::from_value(page["operations"].clone())
            .map_err(|_| "invalid_sync_operations")?;
        let cursor = page["cursor"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 2048)
            .ok_or("invalid_peer_cursor")?;
        let more = page["hasMore"].as_bool().ok_or("invalid_sync_response")?;
        if more && (operations.is_empty() || previous.as_str() == Some(cursor)) {
            return Err("sync_cursor_stalled".into());
        }
        let mut core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
        core.receive_operations(
            &operations,
            Some(LocalCommit {
                key: key.clone(),
                expected,
                value: json!(cursor),
            }),
        )?;
        if !more {
            let (expected, _) = core.sync_checkpoint(&complete_key)?;
            core.set_local_value(&complete_key, expected, &json!(true))?;
            return Ok(());
        }
    }
    Ok(())
}
pub async fn run(host: Arc<Host>) {
    let mut schedule = std::collections::BTreeMap::<String, (u32, tokio::time::Instant)>::new();
    let mut requested = 0;
    loop {
        if let Ok(core) = host.workspace.core.lock() {
            if let Ok((revision, _)) = core.sync_checkpoint("sync:request") {
                if requested != revision {
                    schedule.clear();
                    requested = revision;
                }
            }
        }
        let peers = match shufang_native::sync_config::configured_peers(&host.workspace) {
            Ok(p) => p,
            Err(_) => {
                record_worker_status(&host, Some("sync_configuration_unavailable"));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        record_worker_status(&host, None);
        for (id, url, token) in peers {
            let key = format!(
                "{:x}",
                Sha256::digest(json!([id, url]).to_string().as_bytes())
            );
            let (failures, next) = schedule
                .get(&key)
                .copied()
                .unwrap_or((0, tokio::time::Instant::now()));
            if next > tokio::time::Instant::now() {
                continue;
            }
            let result = tick_peer(
                &host,
                &Peer {
                    id: id.clone(),
                    url,
                    token,
                },
            )
            .await;
            let failures = if result.is_ok() {
                0
            } else {
                failures.saturating_add(1)
            };
            let delay = shufang_application::retry_delay(failures);
            schedule.insert(
                key,
                (
                    failures,
                    tokio::time::Instant::now() + std::time::Duration::from_secs(delay),
                ),
            );
            if let Ok(mut core) = host.workspace.core.lock() {
                if let Ok((revision, mut status)) = core.sync_checkpoint("sync:status") {
                    if !status.is_object() {
                        status = json!({})
                    }
                    let mut value = status.get(&id).cloned().unwrap_or(json!({}));
                    value["failures"] = json!(failures);
                    value["error"] = result
                        .as_ref()
                        .err()
                        .map(|s| json!(s))
                        .unwrap_or(Value::Null);
                    if result.is_ok() {
                        value["lastSuccess"] = json!(chrono::Utc::now().to_rfc3339());
                    }
                    status[&id] = value;
                    let _ = core.set_local_value("sync:status", revision, &status);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

fn record_worker_status(host: &Host, error: Option<&str>) {
    if let Ok(mut core) = host.workspace.core.lock() {
        if let Ok((revision, previous)) = core.sync_checkpoint("sync:worker") {
            let error = error.map(|e| json!(e)).unwrap_or(Value::Null);
            if previous["error"] != error {
                let _ = core.set_local_value(
                    "sync:worker",
                    revision,
                    &json!({"error":error,"updatedAt":chrono::Utc::now().to_rfc3339()}),
                );
            }
        }
    }
}

#[cfg(test)]
mod peer_url_tests {
    use super::{validate, Peer};

    #[test]
    fn accepts_a_https_reverse_proxy_prefix_for_an_isolated_peer() {
        let peer = Peer {
            id: "linux-personal".into(),
            url: "https://us.jiusi.org/__mcp_candidate_20261005__/".into(),
            token: "test-token".into(),
        };
        assert!(validate(&peer).is_ok());
    }
}
