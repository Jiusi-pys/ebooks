//! Local configuration and encrypted credentials, never business replication.
use crate::workspace::{number, string, Result, Workspace};
use serde_json::{json, Value};
use std::sync::Arc;
pub fn validate_url(input: &str) -> Result<()> {
    let url = reqwest::Url::parse(input).map_err(|_| "invalid_peer_url")?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || input.contains('%')
        || url.path().len() > 256
        || !url.path().split('/').all(|segment| {
            segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
        || url.host_str().is_none()
    {
        return Err("invalid_peer_url".into());
    }
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|s| ["localhost", "127.0.0.1", "[::1]"].contains(&s)))
    {
        return Err("peer_requires_https".into());
    }
    Ok(())
}
pub fn public_config(w: &Arc<Workspace>) -> Result<Value> {
    let c = w.core.lock().map_err(|_| "core_lock_failed")?;
    let (revision, value) = c
        .local_value("sync:config")?
        .unwrap_or((0, json!({"paused":true,"peers":[]})));
    let peers = value["peers"]
        .as_array()
        .ok_or("invalid_sync_config")?
        .iter()
        .map(|p| json!({"id":p["id"],"url":p["url"],"configured":p["credential"].is_string()}))
        .collect::<Vec<_>>();
    Ok(
        json!({"revision":revision,"paused":value["paused"],"peers":peers,"identity":c.replication_head()?}),
    )
}
pub fn save_peer(w: &Arc<Workspace>, args: &Value) -> Result<Value> {
    let id = string(args, "id")?;
    let url = string(args, "url")?;
    validate_url(url)?;
    if !shufang_domain::sync::valid_identifier(id) {
        return Err("invalid_peer_id".into());
    }
    let token = args["token"].as_str().unwrap_or("");
    if token.len() > 4096 {
        return Err("invalid_peer_token".into());
    }
    let mut c = w.core.lock().map_err(|_| "core_lock_failed")?;
    let expected = number(args, "expected")?;
    let (revision, mut value) = c
        .local_value("sync:config")?
        .unwrap_or((0, json!({"paused":true,"peers":[]})));
    if revision != expected {
        return Err("revision_conflict".into());
    }
    if c.replication_head()?.node_id == id {
        return Err("peer_identity_is_local".into());
    }
    let peers = value["peers"].as_array_mut().ok_or("invalid_sync_config")?;
    let index = peers.iter().position(|p| p["id"] == id);
    if index.is_none() && peers.len() >= 10 {
        return Err("peer_limit".into());
    }
    let environment = args["tokenEnvironment"].as_str().unwrap_or("");
    if !environment.is_empty() && !token.is_empty() {
        return Err("ambiguous_peer_credential".into());
    }
    let credential = if !environment.is_empty() {
        crate::credentials::environment_reference(environment)?
    } else if token.is_empty() {
        let old = index.map(|i| &peers[i]).ok_or("peer_token_required")?;
        if old["url"] != url.trim_end_matches('/') {
            return Err("peer_token_required".into());
        }
        old["credential"]
            .as_str()
            .ok_or("invalid_sync_config")?
            .to_owned()
    } else {
        let name = format!("sync-peer-{}", uuid::Uuid::new_v4());
        crate::credentials::store(&w.root, &name, token)?;
        name
    };
    let peer = json!({"id":id,"url":url.trim_end_matches('/'),"credential":credential});
    if let Some(i) = index {
        peers[i] = peer;
    } else {
        if peers.len() >= 10 {
            return Err("peer_limit".into());
        }
        peers.push(peer);
    }
    let revision = c.set_local_value("sync:config", expected, &value)?;
    Ok(json!({"revision":revision}))
}
pub fn pause(w: &Arc<Workspace>, args: &Value) -> Result<Value> {
    let mut c = w.core.lock().map_err(|_| "core_lock_failed")?;
    let expected = number(args, "expected")?;
    let (revision, mut value) = c
        .local_value("sync:config")?
        .unwrap_or((0, json!({"paused":true,"peers":[]})));
    if revision != expected {
        return Err("revision_conflict".into());
    }
    value["paused"] = json!(args["paused"].as_bool().ok_or("invalid_paused")?);
    Ok(json!({"revision":c.set_local_value("sync:config",expected,&value)?}))
}
pub fn configured_peers(w: &Arc<Workspace>) -> Result<Vec<(String, String, String)>> {
    let value = w
        .core
        .lock()
        .map_err(|_| "core_lock_failed")?
        .local_value("sync:config")?
        .map(|(_, v)| v)
        .unwrap_or(json!({"paused":true,"peers":[]}));
    if value["paused"] != false {
        return Ok(vec![]);
    }
    value["peers"]
        .as_array()
        .ok_or("invalid_sync_config")?
        .iter()
        .map(|p| {
            Ok((
                string(p, "id")?.to_owned(),
                string(p, "url")?.to_owned(),
                crate::credentials::load(&w.root, string(p, "credential")?)?,
            ))
        })
        .collect()
}

pub fn remove(w: &Arc<Workspace>, args: &Value) -> Result<Value> {
    let mut c = w.core.lock().map_err(|_| "core_lock_failed")?;
    let expected = number(args, "expected")?;
    let (revision, mut value) = c
        .local_value("sync:config")?
        .unwrap_or((0, json!({"paused":true,"peers":[]})));
    if revision != expected {
        return Err("revision_conflict".into());
    }
    let id = string(args, "id")?;
    let peers = value["peers"].as_array_mut().ok_or("invalid_sync_config")?;
    let index = peers
        .iter()
        .position(|p| p["id"] == id)
        .ok_or("peer_not_found")?;
    peers.remove(index);
    Ok(json!({"revision":c.set_local_value("sync:config",expected,&value)?}))
}
pub fn request(w: &Arc<Workspace>) -> Result<Value> {
    let mut c = w.core.lock().map_err(|_| "core_lock_failed")?;
    let value = c
        .local_value("sync:config")?
        .map(|(_, v)| v)
        .unwrap_or(Value::Null);
    if value["paused"] != false {
        return Err("sync_paused".into());
    }
    if value["peers"].as_array().is_none_or(|p| p.is_empty()) {
        return Err("sync_peer_required".into());
    }
    let (revision, _) = c.sync_checkpoint("sync:request")?;
    Ok(json!({"requested":c.set_local_value("sync:request",revision,&json!(true))?}))
}
pub fn status(w: &Arc<Workspace>) -> Result<Value> {
    let c = w.core.lock().map_err(|_| "core_lock_failed")?;
    let (_, peers) = c.sync_checkpoint("sync:status")?;
    let (requested, _) = c.sync_checkpoint("sync:request")?;
    let (_, worker) = c.sync_checkpoint("sync:worker")?;
    Ok(json!({"peers":peers,"requested":requested,"worker":worker}))
}
