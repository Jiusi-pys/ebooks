use crate::{error, ApiResult, Host};
use axum::{
    extract::{Path, State},
    Json,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Arc;
use url::Url;

fn initial() -> Value {
    json!({"subscriptions":{},"deliveries":{},"cursor":0})
}
pub(crate) fn override_commit(
    core: &shufang_native::workspace::Session,
    kind: &str,
    id: &str,
    revision: u64,
    event: &str,
    data: Value,
) -> Result<shufang_application::LocalCommit, String> {
    let (expected, mut value) = core.local_value("webhooks")?.unwrap_or((0, initial()));
    if value.get("overrides").is_none() {
        value["overrides"] = json!({});
    }
    if value["overrides"]
        .as_object()
        .ok_or("invalid_webhooks")?
        .len()
        >= 10_000
    {
        return Err("webhook_limit".into());
    }
    value["overrides"][format!("{kind}:{id}:{revision}")] =
        json!({"type":event,"data":data,"source":"reader"});
    Ok(shufang_application::LocalCommit {
        key: "webhooks".into(),
        expected,
        value,
    })
}
pub async fn deliveries(State(h): State<Arc<Host>>) -> ApiResult {
    let core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let state = core
        .local_value("webhooks")
        .map_err(error)?
        .map(|(_, v)| v)
        .unwrap_or_else(initial);
    let entries: Vec<_> = state["deliveries"].as_object().ok_or_else(|| error("invalid_webhooks".into()))?.iter().map(|(id, d)| json!({"id":id,"subscription":d["subscription"],"event":d["event"],"attempts":d["attempts"],"next":d["next"]})).collect();
    Ok(Json(json!({"deliveries":entries})))
}
pub async fn retry(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (revision, mut state) = core
        .local_value("webhooks")
        .map_err(error)?
        .unwrap_or((0, initial()));
    let delivery = state["deliveries"]
        .get_mut(&id)
        .ok_or_else(|| error("not_found".into()))?;
    delivery["attempts"] = 0.into();
    delivery["next"] = 0.into();
    core.set_local_value("webhooks", revision, &state)
        .map_err(error)?;
    Ok(Json(json!({"ok":true})))
}
pub async fn list(State(h): State<Arc<Host>>) -> ApiResult {
    let value = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?
        .local_value("webhooks")
        .map_err(error)?
        .map(|(_, v)| v)
        .unwrap_or_else(initial);
    let subscriptions = value["subscriptions"]
        .as_object()
        .ok_or_else(|| error("invalid_webhooks".into()))?
        .values()
        .map(|v| {
            let mut v = v.clone();
            v.as_object_mut().unwrap().remove("secret");
            v.as_object_mut().unwrap().remove("secretRef");
            v
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({"webhooks":subscriptions})))
}
pub async fn save(State(h): State<Arc<Host>>, Json(mut value): Json<Value>) -> ApiResult {
    if !value.is_object() {
        return Err(error("invalid_webhook".into()));
    }
    validate(&value).map_err(error)?;
    let url = Url::parse(value["url"].as_str().unwrap_or(""))
        .map_err(|_| error("invalid_webhook_url".into()))?;
    if !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(error("invalid_webhook_url".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(secret) = value["secret"].as_str().filter(|s| !s.is_empty()) {
        shufang_native::credentials::store(&h.workspace.root, &format!("webhook-{id}"), secret)
            .map_err(error)?;
        value["secretRef"] = format!("webhook-{id}").into();
    }
    value.as_object_mut().unwrap().remove("secret");
    value["id"] = id.clone().into();
    value["active"] = true.into();
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (revision, mut state) = core
        .local_value("webhooks")
        .map_err(error)?
        .unwrap_or((0, initial()));
    let next = state["subscriptions"]
        .as_object()
        .ok_or_else(|| error("invalid_webhooks".into()))?
        .values()
        .filter_map(|v| v["legacyId"].as_u64())
        .max()
        .unwrap_or(0)
        .max(state["lastLegacyId"].as_u64().unwrap_or(0))
        + 1;
    state["lastLegacyId"] = next.into();
    value["legacyId"] = next.into();
    value["failCount"] = 0.into();
    value["createdAt"] = (now() * 1000).into();
    if value.get("events").is_none() {
        value["events"] = json!(["*"]);
    }
    if value.get("description").is_none() {
        value["description"] = "".into();
    }
    if state["subscriptions"]
        .as_object()
        .ok_or_else(|| error("invalid_webhooks".into()))?
        .len()
        >= 100
    {
        return Err(error("webhook_limit".into()));
    }
    state["subscriptions"][&id] = value;
    core.set_local_value("webhooks", revision, &state)
        .map_err(error)?;
    Ok(Json(json!({"id":id})))
}
fn validate(value: &Value) -> Result<(), String> {
    if let Some(s) = value.get("url") {
        let url = Url::parse(s.as_str().unwrap_or("")).map_err(|_| "invalid_webhook_url")?;
        if s.as_str().unwrap_or("").len() > 1024
            || !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("invalid_webhook_url".into());
        }
    }
    if let Some(events) = value.get("events") {
        if events.as_array().is_none_or(|a| {
            a.len() > 50
                || a.iter()
                    .any(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 64))
        }) {
            return Err("invalid_webhook_events".into());
        }
    }
    if value
        .get("description")
        .is_some_and(|v| v.as_str().is_none_or(|s| s.len() > 255))
        || value.get("active").is_some_and(|v| !v.is_boolean())
    {
        return Err("invalid_webhook".into());
    }
    Ok(())
}
fn resolve(state: &Value, id: &str) -> Result<String, String> {
    state["subscriptions"]
        .as_object()
        .ok_or("invalid_webhooks")?
        .iter()
        .find(|(key, v)| *key == id || v["legacyId"].as_u64().is_some_and(|n| n.to_string() == id))
        .map(|(k, _)| k.clone())
        .ok_or("not_found".into())
}
pub async fn legacy_list(State(h): State<Arc<Host>>) -> ApiResult {
    let Json(mut result) = list(State(h)).await?;
    for v in result["webhooks"].as_array_mut().unwrap() {
        if let Some(id) = v.get("legacyId").cloned() {
            v["id"] = id;
        }
        v.as_object_mut().unwrap().remove("legacyId");
    }
    Ok(Json(result))
}
pub async fn legacy_save(
    State(h): State<Arc<Host>>,
    Json(value): Json<Value>,
) -> Result<(axum::http::StatusCode, Json<Value>), (axum::http::StatusCode, Json<Value>)> {
    let Json(saved) = save(State(h.clone()), Json(value)).await?;
    let core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let state = core.local_value("webhooks").map_err(error)?.unwrap().1;
    let id = saved["id"].as_str().unwrap();
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({"ok":true,"id":state["subscriptions"][id]["legacyId"]})),
    ))
}
pub async fn update(
    State(h): State<Arc<Host>>,
    Path(id): Path<String>,
    Json(patch): Json<Value>,
) -> ApiResult {
    if patch.as_object().is_none_or(|o| {
        o.keys()
            .any(|s| !["url", "events", "active", "description"].contains(&s.as_str()))
    }) {
        return Err(error("invalid_webhook".into()));
    }
    validate(&patch).map_err(error)?;
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (revision, mut state) = core
        .local_value("webhooks")
        .map_err(error)?
        .unwrap_or((0, initial()));
    let id = resolve(&state, &id).map_err(error)?;
    for (k, v) in patch.as_object().unwrap() {
        state["subscriptions"][&id][k] = v.clone();
    }
    state["subscriptions"][&id]["failCount"] = 0.into();
    core.set_local_value("webhooks", revision, &state)
        .map_err(error)?;
    Ok(Json(json!({"ok":true})))
}
pub async fn legacy_remove(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let resolved = {
        let core = h
            .workspace
            .core
            .lock()
            .map_err(|_| error("core_lock_failed".into()))?;
        let state = core
            .local_value("webhooks")
            .map_err(error)?
            .unwrap_or((0, initial()))
            .1;
        resolve(&state, &id).unwrap_or(id)
    };
    remove(State(h), Path(resolved)).await
}
pub async fn test(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let subscription = {
        let core = h
            .workspace
            .core
            .lock()
            .map_err(|_| error("core_lock_failed".into()))?;
        let state = core
            .local_value("webhooks")
            .map_err(error)?
            .unwrap_or((0, initial()))
            .1;
        let id = resolve(&state, &id).map_err(error)?;
        state["subscriptions"][&id].clone()
    };
    let body=serde_json::to_vec(&json!({"id":uuid::Uuid::new_v4().to_string(),"type":"test.ping","source":"api","timestamp":timestamp(),"data":{"message":"書房 WebHook 测试"}})).unwrap();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("webhook_client_failed".into()))?;
    let mut request = client
        .post(subscription["url"].as_str().unwrap_or(""))
        .header("Content-Type", "application/json")
        .header("X-Shufang-Event", "test.ping")
        .header("User-Agent", "Shufang-Webhook/1.0")
        .body(body.clone());
    if let Some(reference) = subscription["secretRef"].as_str() {
        let secret =
            shufang_native::credentials::load(&h.workspace.root, reference).map_err(error)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .map_err(|_| error("invalid_secret".into()))?;
        mac.update(&body);
        let signature = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        request = request.header("X-Shufang-Signature", format!("sha256={signature}"));
    }
    match request.send().await {
        Ok(r) => Ok(Json(
            json!({"ok":r.status().is_success(),"status":r.status().as_u16()}),
        )),
        Err(_) => Err((
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"ok":false,"error":"deliver failed"})),
        )),
    }
}
pub async fn remove(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (revision, mut state) = core
        .local_value("webhooks")
        .map_err(error)?
        .unwrap_or((0, initial()));
    state["subscriptions"]
        .as_object_mut()
        .ok_or_else(|| error("invalid_webhooks".into()))?
        .remove(&id);
    core.set_local_value("webhooks", revision, &state)
        .map_err(error)?;
    Ok(Json(json!({"ok":true})))
}
pub async fn tick(h: &Arc<Host>) -> Result<(), String> {
    let pending = {
        let mut core = h.workspace.core.lock().map_err(|_| "core_lock_failed")?;
        let (revision, mut state) = core.local_value("webhooks")?.unwrap_or((0, initial()));
        let changes = core.changes(state["cursor"].as_u64().unwrap_or(0), 100)?;
        let changed = !changes.is_empty();
        for change in changes {
            if change
                .snapshot
                .as_ref()
                .is_some_and(|s| s["replicated"] == true)
            {
                state["cursor"] = change.sequence.into();
                continue;
            }
            let kind = match change.kind.as_str() {
                "books" => "book",
                "highlights" => "highlight",
                "notes" => "note",
                "folders" => "folder",
                "studySets" => "studyset",
                "mindMaps" => "mindmap",
                "associations" => "association",
                "translations" => "translation",
                _ => {
                    state["cursor"] = change.sequence.into();
                    continue;
                }
            };
            let event = format!(
                "{kind}.{}",
                if change.deleted {
                    "deleted"
                } else if change.revision == 1 {
                    "created"
                } else {
                    "updated"
                }
            );
            let event = if event == "book.created" {
                "book.imported".to_string()
            } else {
                event
            };
            let subscriptions = state["subscriptions"]
                .as_object()
                .ok_or("invalid_webhooks")?
                .clone();
            if state["deliveries"]
                .as_object()
                .ok_or("invalid_webhooks")?
                .len()
                + subscriptions.len()
                > 10_000
            {
                break;
            }
            let marker = format!("{}:{}:{}", change.kind, change.id, change.revision);
            let override_event = state["overrides"]
                .as_object_mut()
                .and_then(|o| o.remove(&marker));
            let (event, data, source) = if let Some(v) = override_event {
                (
                    v["type"].as_str().ok_or("invalid_webhooks")?.to_owned(),
                    v["data"].clone(),
                    "reader",
                )
            } else {
                let data = if let Some(snapshot) = &change.snapshot {
                    if snapshot["version"] != 1 {
                        return Err("unsupported_journal_snapshot".into());
                    }
                    crate::legacy::project(
                        &format!("{kind}s"),
                        &snapshot["record"],
                        snapshot["related"]["folders"]
                            .as_array()
                            .ok_or("invalid_journal_snapshot")?,
                        snapshot["related"]["books"]
                            .as_array()
                            .ok_or("invalid_journal_snapshot")?,
                        false,
                    )
                } else if change.deleted {
                    json!({"extId":change.id})
                } else {
                    let r = serde_json::to_value(core.entity(&change.kind, &change.id).ok())
                        .map_err(|e| e.to_string())?;
                    if r.is_null() {
                        json!({"extId":change.id})
                    } else {
                        let folders = core
                            .entities("folders")?
                            .into_iter()
                            .map(|r| serde_json::to_value(r).unwrap())
                            .collect::<Vec<_>>();
                        let books = core
                            .entities("books")?
                            .into_iter()
                            .map(|r| serde_json::to_value(r).unwrap())
                            .collect::<Vec<_>>();
                        crate::legacy::project(&format!("{kind}s"), &r, &folders, &books, false)
                    }
                };
                (event, data, "native")
            };
            let body = json!({"id":uuid::Uuid::new_v4().to_string(),"type":event,"data":data,"source":source,"timestamp":timestamp()});
            for (id, subscription) in subscriptions {
                if subscription["active"] == false {
                    continue;
                }
                if let Some(events) = subscription["events"].as_array() {
                    if !events.iter().any(|e| e == "*" || e == &event) {
                        continue;
                    }
                }
                let delivery = format!("{}-{}", change.sequence, id);
                state["deliveries"][&delivery] =
                    json!({"subscription":id,"attempts":0,"next":0,"event":event,"body":body});
            }
            state["cursor"] = change.sequence.into();
        }
        if changed {
            core.set_local_value("webhooks", revision, &state)?;
        }
        let now = now();
        state["deliveries"]
            .as_object()
            .ok_or("invalid_webhooks")?
            .iter()
            .filter(|(_, d)| {
                d["next"].as_u64().unwrap_or(0) <= now && d["attempts"].as_u64().unwrap_or(0) < 8
            })
            .take(20)
            .map(|(id, d)| {
                (
                    id.clone(),
                    d.clone(),
                    state["subscriptions"][d["subscription"].as_str().unwrap_or("")].clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    for (id, delivery, subscription) in pending {
        let body = serde_json::to_vec(&delivery["body"]).map_err(|e| e.to_string())?;
        let mut request = client
            .post(subscription["url"].as_str().unwrap_or(""))
            .header("Content-Type", "application/json")
            .header("X-Shufang-Delivery", &id)
            .header("X-Shufang-Event", delivery["event"].as_str().unwrap_or(""))
            .body(body.clone());
        if let Some(reference) = subscription["secretRef"].as_str() {
            let secret = shufang_native::credentials::load(&h.workspace.root, reference)?;
            let mut mac =
                Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| "invalid_secret")?;
            mac.update(&body);
            let signature = mac
                .finalize()
                .into_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            request = request.header("X-Shufang-Signature", format!("sha256={signature}"));
        }
        let success = if subscription.is_null() || subscription["active"] == false {
            true
        } else {
            request.send().await.is_ok_and(|r| r.status().is_success())
        };
        let mut core = h.workspace.core.lock().map_err(|_| "core_lock_failed")?;
        let (revision, mut state) = core.local_value("webhooks")?.unwrap_or((0, initial()));
        if success {
            if let Some(v) =
                state["subscriptions"].get_mut(delivery["subscription"].as_str().unwrap_or(""))
            {
                v["failCount"] = 0.into();
            }
            state["deliveries"]
                .as_object_mut()
                .ok_or("invalid_webhooks")?
                .remove(&id);
        } else {
            if let Some(v) =
                state["subscriptions"].get_mut(delivery["subscription"].as_str().unwrap_or(""))
            {
                v["failCount"] = (v["failCount"].as_u64().unwrap_or(0) + 1).into();
            }
            let attempts = delivery["attempts"].as_u64().unwrap_or(0) + 1;
            state["deliveries"][&id]["attempts"] = attempts.into();
            state["deliveries"][&id]["next"] = (now() + 2u64.pow(attempts as u32).min(3600)).into();
        }
        core.set_local_value("webhooks", revision, &state)?;
    }
    Ok(())
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
