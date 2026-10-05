//! One-time conversion of Node OAuth v1 hashes and owner-bound grants.
use crate::Host;
use serde_json::{json, Map, Value};
use std::path::Path;
type Result<T> = std::result::Result<T, String>;
fn object<'a>(value: &'a Value, key: &str) -> Result<&'a Map<String, Value>> {
    let values = value[key].as_object().ok_or("invalid_node_oauth_state")?;
    if values.len() > 16384 {
        return Err("oauth_import_limit".into());
    }
    Ok(values)
}
fn deadline(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .map(|v| v / 1000)
        .ok_or("invalid_node_oauth_deadline".into())
}
fn owner(value: &Value) -> Result<Value> {
    if value["userId"]
        .as_str()
        .is_none_or(|s| s.is_empty() || s.encode_utf16().count() > 256)
        || value["credentialVersion"].as_u64().is_none_or(|v| v == 0)
    {
        return Err("invalid_node_oauth_owner".into());
    }
    Ok(value.clone())
}
fn request(value: &Value) -> Result<Value> {
    for key in [
        "client_id",
        "redirect_uri",
        "code_challenge",
        "resource",
        "state",
    ] {
        if value[key].as_str().is_none_or(|s| s.len() > 8192) {
            return Err("invalid_node_oauth_request".into());
        }
    }
    if value["response_type"] != "code"
        || value["code_challenge_method"] != "S256"
        || value["scope"] != "library:read"
    {
        return Err("invalid_node_oauth_request".into());
    }
    Ok(
        json!({"client":value["client_id"],"redirect":value["redirect_uri"],"challenge":value["code_challenge"],"state":value["state"],"resource":value["resource"]}),
    )
}
pub fn convert(value: &Value) -> Result<Value> {
    if value["version"] != 1 {
        return Err("unsupported_node_oauth_state".into());
    }
    let mut result =
        json!({"clients":{},"pending":{},"codes":{},"access":{},"refresh":{},"used_refresh":{}});
    result["clients"] = Value::Object(object(value, "clients")?.clone());
    for (id, pending) in object(value, "pending")? {
        let mut item = request(&pending["request"])?;
        let csrf = pending["csrfHash"]
            .as_str()
            .filter(|s| s.len() == 64)
            .ok_or("invalid_node_oauth_csrf")?;
        item["csrfHash"] = csrf.into();
        item["expires"] = deadline(&pending["expires"])?.into();
        result["pending"][id] = item;
    }
    for (id, code) in object(value, "codes")? {
        let mut item = request(&code["request"])?;
        item["owner"] = owner(&code["owner"])?;
        item["expires"] = deadline(&code["expires"])?.into();
        result["codes"][id] = item;
    }
    let grants = object(value, "grants")?;
    for (id, token) in object(value, "tokens")? {
        let grant_id = token["grantId"]
            .as_str()
            .ok_or("invalid_node_oauth_token")?;
        let Some(grant) = grants.get(grant_id) else {
            continue;
        };
        if grant["revoked"] == true {
            continue;
        }
        if grant["revoked"] != false
            || grant["scope"] != "library:read"
            || grant["clientId"].as_str().is_none()
            || grant["resource"].as_str().is_none()
        {
            return Err("invalid_node_oauth_grant".into());
        }
        let expires = deadline(&token["expires"])?;
        let grant_expires = deadline(&grant["expires"])?;
        let item = json!({"client":grant["clientId"],"resource":grant["resource"],"scope":"library:read","owner":owner(&grant["owner"])? ,"grant":grant_id,"expires":expires.min(grant_expires),"grant_expires":grant_expires});
        match (token["kind"].as_str(), token["used"].as_bool()) {
            (Some("access"), Some(false)) => result["access"][id] = item,
            (Some("refresh"), Some(false)) => result["refresh"][id] = item,
            (Some("refresh"), Some(true)) => {
                result["used_refresh"][id] = json!({"grant":grant_id,"expires":grant_expires})
            }
            (Some("access"), Some(true)) => {}
            _ => return Err("invalid_node_oauth_token".into()),
        }
    }
    Ok(result)
}
pub fn import(host: &Host, path: &Path) -> Result<()> {
    if !path.is_absolute() || host.is_read_only() {
        return Err("oauth_import_requires_writer".into());
    }
    let metadata = std::fs::metadata(path).map_err(|_| "oauth_import_unavailable")?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("oauth_import_limit".into());
    }
    let value: Value =
        serde_json::from_reader(std::fs::File::open(path).map_err(|_| "oauth_import_unavailable")?)
            .map_err(|_| "invalid_node_oauth_state")?;
    let converted = convert(&value)?;
    let mut core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
    if core.local_value("oauth-store")?.is_some() {
        return Err("oauth_import_already_initialized".into());
    }
    core.set_local_value("oauth-store", 0, &converted)?;
    Ok(())
}
