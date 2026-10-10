//! Service scheduling adapter; shared native transport owns all network synchronization.
use crate::Host;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
pub async fn tick_peer(host: &Arc<Host>, peer: &Peer) -> Result<(), String> {
    validate(peer)?;
    let shared =
        shufang_native::transport_host::SyncHost::new(host.workspace.clone(), host.is_read_only());
    shufang_native::replication::tick_peer(
        &shared,
        &shufang_native::replication::Peer {
            id: peer.id.clone(),
            url: peer.url.clone(),
            token: peer.token.clone(),
            cookie: None,
        },
    )
    .await
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
