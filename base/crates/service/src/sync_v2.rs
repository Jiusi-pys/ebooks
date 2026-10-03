//! HTTP v2 adapter. All state changes run through shared application use cases.
use crate::{same_secret, Host};
use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_domain::sync::Operation;
use std::{collections::HashMap, sync::Arc};
type Api = Result<Json<Value>, (StatusCode, Json<Value>)>;
pub(crate) fn error(e: String) -> (StatusCode, Json<Value>) {
    let status = if [
        "operation_id_reused",
        "revision_conflict",
        "clock_conflict",
        "cursor_scope_mismatch",
        "snapshot_head_changed",
        "review_events_are_immutable",
    ]
    .contains(&e.as_str())
    {
        StatusCode::CONFLICT
    } else if e == "workspace_identity_mismatch" {
        StatusCode::FORBIDDEN
    } else if e == "snapshot_not_found" || e == "entity_not_found" {
        StatusCode::NOT_FOUND
    } else if e.starts_with("storage_error") || e == "core_lock_failed" {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::BAD_REQUEST
    };
    (status, Json(json!({"error":e})))
}
pub fn router(host: Arc<Host>) -> Router<Arc<Host>> {
    Router::new()
        .route("/api/v2/capabilities", get(capabilities))
        .route("/api/v2/openapi.json", get(openapi))
        .route("/api/v2/sync/push", post(push))
        .route("/api/v2/mutations", post(mutation))
        .route("/api/v2/sync/changes", get(changes))
        .route("/api/v2/sync/snapshots", post(snapshot))
        .route("/api/v2/sync/snapshots/{id}", get(snapshot_page))
        .route("/api/v2/entities", get(entities))
        .route("/api/v2/entities/{kind}/{id}/history", get(history))
        .route("/api/v2/entities/{kind}/{id}/restore", post(restore))
        .route("/api/v2/status", get(status))
        .route("/api/v2/peers", post(pair))
        .route("/api/v2/peers/{id}", axum::routing::delete(revoke))
        .merge(crate::sync_blobs::router())
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(host, authorize))
}
async fn authorize(State(host): State<Arc<Host>>, request: Request, next: Next) -> Response {
    let key = request
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
        })
        .unwrap_or("");
    if !key.is_empty() && same_secret(key, &host.token) {
        return next.run(request).await;
    }
    let authorized = {
        let core = match host.workspace.core.lock() {
            Ok(c) => c,
            Err(_) => return error("core_lock_failed".into()).into_response(),
        };
        let head = match core.replication_head() {
            Ok(h) => h,
            Err(e) => return error(e).into_response(),
        };
        let requested = request
            .headers()
            .get("x-workspace-id")
            .and_then(|v| v.to_str().ok());
        match core.local_value("sync:credentials") {
            Ok(Some((_, credentials)))
                if requested == Some(head.workspace_id.as_str()) && !key.is_empty() =>
            {
                credentials.as_object().is_some_and(|o| {
                    o.values().any(|v| {
                        v.as_str().is_some_and(|s| {
                            same_secret(s, &format!("{:x}", Sha256::digest(key.as_bytes())))
                        })
                    })
                })
            }
            _ => false,
        }
    };
    if authorized {
        if request.uri().path().starts_with("/api/v2/peers") {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"owner_required"})),
            )
                .into_response();
        }
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"unauthorized"})),
    )
        .into_response()
}
async fn pair(
    State(h): State<Arc<Host>>,
    Json(input): Json<Value>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let id = input["id"]
        .as_str()
        .filter(|s| shufang_domain::sync::valid_identifier(s))
        .ok_or_else(|| error("invalid_peer_id".into()))?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (revision, mut credentials) = c
        .local_value("sync:credentials")
        .map_err(error)?
        .unwrap_or((0, json!({})));
    if credentials
        .as_object()
        .is_none_or(|v| v.len() >= 100 && !v.contains_key(id))
    {
        return Err(error("peer_limit".into()));
    }
    credentials[id] = json!(format!("{:x}", Sha256::digest(token.as_bytes())));
    c.set_local_value("sync:credentials", revision, &credentials)
        .map_err(error)?;
    let workspace = c.replication_head().map_err(error)?.workspace_id;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"token":token,"workspaceId":workspace})),
    ))
}
async fn revoke(State(h): State<Arc<Host>>, Path(id): Path<String>) -> Api {
    if !shufang_domain::sync::valid_identifier(&id) {
        return Err(error("invalid_peer_id".into()));
    }
    let mut c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (revision, mut credentials) = c
        .local_value("sync:credentials")
        .map_err(error)?
        .unwrap_or((0, json!({})));
    credentials
        .as_object_mut()
        .ok_or_else(|| error("invalid_credentials".into()))?
        .remove(&id);
    c.set_local_value("sync:credentials", revision, &credentials)
        .map_err(error)?;
    Ok(Json(json!({"ok":true})))
}
async fn capabilities(State(h): State<Arc<Host>>) -> Api {
    let c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let head = c.replication_head().map_err(error)?;
    Ok(Json(
        json!({"version":2,"workspaceId":head.workspace_id,"nodeId":head.node_id,"epoch":head.epoch,"kinds":shufang_domain::sync::ENTITY_KINDS,"maxBatch":100,"maxBytes":1024*1024,"chunkSize":256*1024}),
    ))
}
async fn openapi() -> Json<Value> {
    Json(crate::sync_openapi::document())
}
pub fn cursor(head: &shufang_application::ReplicationHead, seq: u64) -> String {
    URL_SAFE_NO_PAD.encode(json!({"workspace":head.workspace_id,"node":head.node_id,"epoch":head.epoch,"seq":seq.to_string()}).to_string())
}
fn sequence(
    head: &shufang_application::ReplicationHead,
    input: Option<&str>,
) -> Result<u64, String> {
    let Some(input) = input else { return Ok(0) };
    if input.len() > 2048 {
        return Err("invalid_cursor".into());
    }
    let value: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(input)
            .map_err(|_| "invalid_cursor")?,
    )
    .map_err(|_| "invalid_cursor")?;
    if value["workspace"] != head.workspace_id
        || value["node"] != head.node_id
        || value["epoch"] != head.epoch
    {
        return Err("cursor_scope_mismatch".into());
    }
    let text = value["seq"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()))
        .ok_or("invalid_cursor")?;
    let seq: u64 = text.parse().map_err(|_| "invalid_cursor")?;
    if seq > head.sequence.parse().map_err(|_| "invalid_head")? {
        return Err("invalid_cursor".into());
    }
    Ok(seq)
}
async fn push(State(h): State<Arc<Host>>, Json(input): Json<Value>) -> Api {
    let operations = input["operations"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(|| error("invalid_batch".into()))?;
    let mut receipts = Vec::new();
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    for raw in operations {
        let result = serde_json::from_value::<Operation>(raw.clone())
            .map_err(|_| "validation_failed".to_owned())
            .and_then(|op| {
                core.receive_operations(std::slice::from_ref(&op), None)
                    .map(|duplicates| (op, duplicates[0]))
            });
        match result {
            Ok((op, duplicate)) => {
                let sequence = core
                    .replication_operation_sequence(&op.operation_id)
                    .map_err(error)?
                    .ok_or_else(|| error("operation_not_persisted".into()))?
                    .to_string();
                receipts.push(json!({"operationId":op.operation_id,"persisted":true,"duplicate":duplicate,"seq":sequence}));
            }
            Err(e) if operations.len() == 1 => return Err(error(e)),
            Err(e) => receipts
                .push(json!({"operationId":raw.get("operationId"),"persisted":false,"error":e})),
        }
    }
    Ok(Json(json!({"receipts":receipts})))
}
async fn mutation(State(h): State<Arc<Host>>, Json(input): Json<Value>) -> Api {
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let head = core.replication_head().map_err(error)?;
    let operation_id = match input.get("operationId") {
        None | Some(Value::Null) => uuid::Uuid::new_v4().to_string(),
        Some(Value::String(id)) => id.clone(),
        _ => return Err(error("invalid_operation_id".into())),
    };
    let clock = match input.get("clock") {
        None | Some(Value::Null) => core.mutation_clock(&operation_id).map_err(error)?,
        Some(Value::String(clock)) => clock.clone(),
        _ => return Err(error("invalid_clock".into())),
    };
    let kind = input["kind"]
        .as_str()
        .ok_or_else(|| error("invalid_kind".into()))?;
    let raw = json!({"workspaceId":head.workspace_id,"replicaId":head.node_id,"operationId":operation_id,"kind":kind,"entityId":if kind=="reviews" {json!(operation_id)} else {input["entityId"].clone()},"clock":clock,"patch":input.get("patch").filter(|v| !v.is_null()).cloned().unwrap_or(json!({})),"unset":input.get("unset").filter(|v| !v.is_null()).cloned().unwrap_or(json!([])),"deleted":input.get("deleted").filter(|v| !v.is_null()).cloned().unwrap_or(json!(false))});
    let operation: Operation =
        serde_json::from_value(raw).map_err(|_| error("validation_failed".into()))?;
    let (duplicate, sequence) = core.mutate_replica_entity(operation).map_err(error)?;
    Ok(Json(
        json!({"operationId":operation_id,"seq":sequence.to_string(),"duplicate":duplicate}),
    ))
}
async fn changes(State(h): State<Arc<Host>>, Query(q): Query<HashMap<String, String>>) -> Api {
    let c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let head = c.replication_head().map_err(error)?;
    let mut seq = sequence(&head, q.get("cursor").map(String::as_str)).map_err(error)?;
    let mut accepted = Vec::new();
    let mut bytes = 0;
    for row in c.replication_operations(seq, 100).map_err(error)? {
        let size = serde_json::to_vec(&row.operation)
            .map_err(|_| error("invalid_operation".into()))?
            .len();
        if !accepted.is_empty() && bytes + size > 1024 * 1024 {
            break;
        }
        bytes += size;
        seq = row.sequence;
        accepted.push(row.operation);
    }
    Ok(Json(
        json!({"operations":accepted,"cursor":cursor(&head,seq),"hasMore":seq<head.sequence.parse::<u64>().map_err(|_|error("invalid_head".into()))?}),
    ))
}
async fn snapshot(
    State(h): State<Arc<Host>>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let mut c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let head = c.replication_head().map_err(error)?;
    let seq = head
        .sequence
        .parse()
        .map_err(|_| error("invalid_head".into()))?;
    let checkpoint = cursor(&head, seq);
    let id = uuid::Uuid::new_v4().to_string();
    c.create_sync_snapshot(&id, &checkpoint, seq)
        .map_err(error)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"cursor":checkpoint})),
    ))
}
fn page(states: Vec<shufang_domain::sync::EntityState>, checkpoint: Option<String>) -> Json<Value> {
    let next = states.last().map(|s| format!("{}:{}", s.kind, s.id));
    let mut value = json!({"entities":states,"next":next});
    if let Some(c) = checkpoint {
        value["cursor"] = json!(c)
    }
    Json(value)
}
async fn snapshot_page(
    State(h): State<Arc<Host>>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Api {
    let c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (cursor, states) = c
        .sync_snapshot_page(&id, q.get("after").map_or("", String::as_str))
        .map_err(error)?;
    Ok(page(states, Some(cursor)))
}
async fn entities(State(h): State<Arc<Host>>, Query(q): Query<HashMap<String, String>>) -> Api {
    let c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    Ok(page(
        c.replication_entities(
            q.get("kind").map(String::as_str),
            q.get("after").map_or("", String::as_str),
        )
        .map_err(error)?,
        None,
    ))
}
async fn status(State(h): State<Arc<Host>>) -> Api {
    let c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let head = c.replication_head().map_err(error)?;
    let peers = c
        .local_value("sync:status")
        .map_err(error)?
        .map(|(_, v)| v)
        .unwrap_or(json!({}));
    Ok(Json(
        json!({"workspaceId":head.workspace_id,"nodeId":head.node_id,"sequence":head.sequence,"peers":peers}),
    ))
}

async fn history(State(h): State<Arc<Host>>, Path((kind, id)): Path<(String, String)>) -> Api {
    let c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    Ok(Json(
        json!({"operations":c.entity_history(&kind,&id).map_err(error)?}),
    ))
}
async fn restore(
    State(h): State<Arc<Host>>,
    Path((kind, source)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Api {
    let operation = input["operationId"]
        .as_str()
        .ok_or_else(|| error("invalid_operation_id".into()))?;
    let id = input["newEntityId"].as_str().unwrap_or(operation);
    let mut c = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let (duplicate, sequence) = c
        .restore_replica_entity(&kind, &source, id, operation)
        .map_err(error)?;
    Ok(Json(
        json!({"entityId":id,"receipt":{"operationId":operation,"duplicate":duplicate,"seq":sequence.to_string()}}),
    ))
}
