//! One-time import of the legacy node peer list, with private credential files.
use crate::Host;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
pub fn import(host: &Host, encoded: &str) -> Result<(), String> {
    if host.is_read_only() {
        return Err("peer_import_requires_writer".into());
    }
    if encoded.len() > 64 * 1024 {
        return Err("peer_import_limit".into());
    }
    let rows: Vec<Value> = serde_json::from_str(encoded).map_err(|_| "invalid_legacy_peers")?;
    if rows.len() > 10 {
        return Err("peer_limit".into());
    }
    let fingerprint = format!("{:x}", Sha256::digest(encoded.as_bytes()));
    let mut core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
    if let Some((_, marker)) = core.local_value("migration:node-peers")? {
        return if marker["fingerprint"] == fingerprint {
            Ok(())
        } else {
            Err("peer_import_already_initialized".into())
        };
    }
    if core.local_value("sync:config")?.is_some() {
        return Err("peer_import_config_exists".into());
    }
    let local = core.replication_head()?.node_id;
    let mut ids = HashSet::new();
    for row in &rows {
        let id = row["id"].as_str().ok_or("invalid_peer_id")?;
        let url = row["url"].as_str().ok_or("invalid_peer_url")?;
        let token = row["token"].as_str().ok_or("peer_token_required")?;
        if !shufang_domain::sync::valid_identifier(id) || id == local || !ids.insert(id) {
            return Err("invalid_peer_id".into());
        }
        shufang_native::sync_config::validate_url(url)?;
        if token.is_empty() || token.len() > 4096 {
            return Err("invalid_peer_token".into());
        }
    }
    let mut peers = Vec::new();
    for row in rows {
        let credential = format!("sync-peer-{}", uuid::Uuid::new_v4());
        shufang_native::credentials::store(
            &host.workspace.root,
            &credential,
            row["token"].as_str().unwrap(),
        )?;
        peers.push(json!({"id":row["id"],"url":row["url"].as_str().unwrap().trim_end_matches('/'),"credential":credential}));
    }
    core.with_receipt(
        "migration:node-peers",
        &fingerprint,
        vec![shufang_application::LocalCommit {
            key: "sync:config".into(),
            expected: 0,
            value: json!({"paused":false,"peers":peers}),
        }],
        |c| c.commit_receipt(),
    )?;
    Ok(())
}
