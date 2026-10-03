mod incoming_snapshot;
pub mod legacy;
mod legacy_validation;
pub mod mcp;
pub mod oauth;
pub mod replication;
mod sync_blobs;
mod sync_openapi;
pub mod sync_v2;
pub mod webhooks;
use axum::{
    extract::{Multipart, Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_native::workspace::Workspace;
use std::sync::Arc;

pub struct Host {
    pub workspace: Arc<Workspace>,
    pub token: String,
    pub base_url: String,
    pub stop: tokio::sync::Notify,
}
impl Host {
    pub fn new(workspace: Arc<Workspace>, token: String, base_url: String) -> Arc<Self> {
        Arc::new(Self {
            workspace,
            token,
            base_url: base_url.trim_end_matches('/').into(),
            stop: tokio::sync::Notify::new(),
        })
    }
}
pub fn same_secret(left: &str, right: &str) -> bool {
    let a = Sha256::digest(left.as_bytes());
    let b = Sha256::digest(right.as_bytes());
    a.iter().zip(b).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
}
pub fn router(host: Arc<Host>) -> Router {
    let protected = Router::new()
        .route(
            "/admin/status",
            get(|| async { Json(json!({"ok":true,"service":"shufang-native"})) }),
        )
        .route(
            "/admin/stop",
            post(|State(h): State<Arc<Host>>| async move {
                h.stop.notify_one();
                Json(json!({"ok":true}))
            }),
        )
        .route("/admin/sync", get(sync_configuration).patch(sync_pause))
        .route("/admin/sync/peers", post(sync_peer))
        .route("/admin/sync/peers/{id}", delete(sync_remove))
        .route("/admin/sync/run", post(sync_request))
        .route("/api/native/v1/{kind}", get(list).post(create))
        .route(
            "/api/native/v1/{kind}/{id}",
            get(one).patch(update).delete(remove),
        )
        .route("/api/native/v1/books/{id}/chapters", get(chapters))
        .route("/api/native/v1/books/{id}/chapters/{index}", get(chapter))
        .route("/api/native/v1/books/{id}/state", get(reader_state))
        .route("/api/v1/{kind}", get(legacy::list).post(legacy::create))
        .route(
            "/api/v1/{kind}/{id}",
            get(legacy::one)
                .patch(legacy::update)
                .delete(legacy::remove),
        )
        .route("/api/v1/books/{id}/chapters", get(legacy::chapters))
        .route("/api/v1/books/{id}/chapters/{index}", get(legacy::chapter))
        .route("/api/v1/books/{id}/state", get(legacy::reader_state))
        .route(
            "/api/v1/books/import",
            post(import_book).layer(axum::extract::DefaultBodyLimit::max(513 * 1024 * 1024)),
        )
        .route("/api/v1/highlights/{id}/review", post(review))
        .route(
            "/api/v1/highlights/{id}/review-enrollment",
            post(review_enrollment),
        )
        .route("/api/v1/review-queue", get(review_queue))
        .route("/api/v1/citations", post(cite))
        .route("/api/v1/events", post(legacy::events))
        .route("/api/v1/review/due", get(legacy::due))
        .route("/api/v1/digest/{hash}", get(legacy::digest))
        .route("/api/v1/ask", post(legacy::ask))
        .route("/api/v1/translate", post(legacy::translate))
        .route("/api/v1/changes", get(changes))
        .route("/api/v1/search", post(search))
        .route("/api/v1/ai", post(ai))
        .route("/api/v1/jobs/{id}", get(job).delete(cancel_job))
        .route(
            "/api/native/v1/webhooks",
            get(webhooks::list).post(webhooks::save),
        )
        .route("/api/native/v1/webhooks/{id}", delete(webhooks::remove))
        .route(
            "/api/v1/webhooks",
            get(webhooks::legacy_list).post(webhooks::legacy_save),
        )
        .route(
            "/api/v1/webhooks/{id}",
            axum::routing::patch(webhooks::update).delete(webhooks::legacy_remove),
        )
        .route("/api/v1/webhooks/{id}/test", post(webhooks::test))
        .route("/admin/webhook-deliveries", get(webhooks::deliveries))
        .route(
            "/admin/webhook-deliveries/{id}/retry",
            post(webhooks::retry),
        )
        .route("/mcp", post(mcp_http))
        .layer(middleware::from_fn_with_state(host.clone(), authorize));
    Router::new()
        .merge(protected)
        .merge(sync_v2::router(host.clone()))
        .merge(oauth::router())
        .route("/api/v1/", get(legacy::directory))
        .route("/api/v1", get(legacy::directory))
        .route("/health", get(|| async { Json(json!({"ok":true})) }))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(host)
}
async fn authorize(State(host): State<Arc<Host>>, request: Request, next: Next) -> Response {
    let key = request
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !key.is_empty() && same_secret(key, &host.token) {
        return next.run(request).await;
    }
    let token = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    if let Some(token) = token {
        if same_secret(token, &host.token) {
            return next.run(request).await;
        }
        if oauth::valid_access(&host, token)
            && (request.uri().path() == "/mcp"
                || (request.method() == "GET"
                    && request.uri().path().starts_with("/api/v1/")
                    && request
                        .uri()
                        .path()
                        .strip_prefix("/api/v1/")
                        .is_some_and(|p| {
                            matches!(
                                p.split('/').next(),
                                Some(
                                    "books"
                                        | "notes"
                                        | "folders"
                                        | "highlights"
                                        | "associations"
                                        | "translations"
                                        | "mindmaps"
                                        | "studysets"
                                )
                            )
                        })))
        {
            return next.run(request).await;
        }
    }
    (
        StatusCode::UNAUTHORIZED,
        [(
            "WWW-Authenticate",
            format!(
                "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\"",
                host.base_url
            ),
        )],
        Json(json!({"error":"unauthorized"})),
    )
        .into_response()
}
pub type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;
pub fn error(message: String) -> (StatusCode, Json<Value>) {
    let status = match message.as_str() {
        "transport_cache_limit" => StatusCode::TOO_MANY_REQUESTS,
        "ai_not_configured" | "model_not_selected" | "codex_unavailable" => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        "not_found" | "entity_deleted" => StatusCode::NOT_FOUND,
        "revision_conflict"
        | "clock_conflict"
        | "delivery_conflict"
        | "upload_conflict"
        | "upload_incomplete"
        | "book_deleted"
        | "note_deleted"
        | "association_exists"
        | "association_conflict" => StatusCode::CONFLICT,
        _ if message.starts_with("storage_error") => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    (
        status,
        Json(
            json!({"error":if status==StatusCode::INTERNAL_SERVER_ERROR{"storage_error".into()}else{message}}),
        ),
    )
}
pub async fn call(host: Arc<Host>, action: &str, args: Value) -> ApiResult {
    let action = action.to_string();
    tokio::task::spawn_blocking(move || host.workspace.execute(&action, args))
        .await
        .map_err(|_| error("worker_failed".into()))?
        .map(Json)
        .map_err(error)
}
fn kind(value: &str) -> Result<&str, String> {
    match value {
        "mindmaps" => Ok("mindMaps"),
        "studysets" => Ok("studySets"),
        "books" | "notes" | "folders" | "highlights" | "associations" | "translations" => Ok(value),
        _ => Err("not_found".into()),
    }
}
pub fn external(record: &Value) -> Value {
    let mut value = record["value"].clone();
    value["extId"] = value["id"].clone();
    value["revision"] = record["revision"].clone();
    value
}
async fn list(State(h): State<Arc<Host>>, Path(name): Path<String>) -> ApiResult {
    let k = kind(&name).map_err(error)?;
    let Json(rows) = call(h, "list", json!({"kind":k})).await?;
    Ok(Json(
        json!({name:rows.as_array().unwrap_or(&vec![]).iter().map(external).collect::<Vec<_>>()}),
    ))
}
async fn one(State(h): State<Arc<Host>>, Path((name, id)): Path<(String, String)>) -> ApiResult {
    let k = kind(&name).map_err(error)?;
    let Json(record) = call(h, "get", json!({"kind":k,"id":id})).await?;
    Ok(Json(external(&record)))
}
async fn create(
    State(h): State<Arc<Host>>,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> ApiResult {
    let k = kind(&name).map_err(error)?;
    let id = body["extId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let fields = body
        .as_object_mut()
        .ok_or_else(|| error("invalid_body".into()))?;
    fields.remove("extId");
    fields.remove("id");
    fields.remove("revision");
    let Json(record) = call(
        h,
        "save",
        json!({"kind":k,"id":id,"patch":body,"expected":0}),
    )
    .await?;
    Ok(Json(external(&record)))
}
async fn update(
    State(h): State<Arc<Host>>,
    Path((name, id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> ApiResult {
    let k = kind(&name).map_err(error)?;
    let Json(prior) = call(h.clone(), "get", json!({"kind":k,"id":id})).await?;
    let expected = body["revision"]
        .as_u64()
        .or_else(|| {
            headers
                .get("if-match")
                .and_then(|h| h.to_str().ok())
                .and_then(|v| v.trim_matches('"').parse().ok())
        })
        .unwrap_or(prior["revision"].as_u64().unwrap_or(0));
    let fields = body
        .as_object_mut()
        .ok_or_else(|| error("invalid_body".into()))?;
    fields.remove("revision");
    fields.remove("extId");
    fields.remove("id");
    let Json(record) = call(
        h,
        "save",
        json!({"kind":k,"id":id,"patch":body,"expected":expected}),
    )
    .await?;
    Ok(Json(external(&record)))
}
async fn remove(
    State(h): State<Arc<Host>>,
    Path((name, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let k = kind(&name).map_err(error)?;
    let Json(prior) = call(h.clone(), "get", json!({"kind":k,"id":id})).await?;
    let expected = headers
        .get("if-match")
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.trim_matches('"').parse::<u64>().ok())
        .unwrap_or(prior["revision"].as_u64().unwrap_or(0));
    let _ = call(h, "delete", json!({"kind":k,"id":id,"expected":expected})).await?;
    Ok(Json(json!({"ok":true})))
}
async fn chapters(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let Json(book) = call(h, "get", json!({"kind":"books","id":id})).await?;
    Ok(Json(json!({"chapters":book["value"]["chapters"]})))
}
async fn chapter(
    State(h): State<Arc<Host>>,
    Path((id, index)): Path<(String, usize)>,
) -> ApiResult {
    let Json(book) = call(h, "get", json!({"kind":"books","id":id})).await?;
    let value = book["value"]["chapters"]
        .get(index)
        .ok_or_else(|| error("not_found".into()))?;
    Ok(Json(value.clone()))
}
async fn reader_state(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let Json(book) = call(h, "get", json!({"kind":"books","id":id})).await?;
    Ok(Json(
        json!({"progress":book["value"]["progress"],"readingSessions":book["value"]["readingSessions"]}),
    ))
}
async fn changes(
    State(h): State<Arc<Host>>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult {
    call(
        h,
        "changes",
        json!({"after":query.get("after").and_then(|s|s.parse::<u64>().ok()).unwrap_or(0)}),
    )
    .await
}
async fn review(
    State(h): State<Arc<Host>>,
    Path(id): Path<String>,
    Json(mut args): Json<Value>,
) -> ApiResult {
    if !args.is_object() {
        return Err(error("invalid_body".into()));
    }
    args["id"] = id.into();
    call(h, "review", args).await
}
async fn cite(State(h): State<Arc<Host>>, Json(args): Json<Value>) -> ApiResult {
    call(h, "cite", args).await
}
async fn review_enrollment(
    State(h): State<Arc<Host>>,
    Path(id): Path<String>,
    Json(mut args): Json<Value>,
) -> ApiResult {
    if !args.is_object() {
        return Err(error("invalid_body".into()));
    }
    args["id"] = id.into();
    call(h, "setReview", args).await
}
async fn review_queue(
    State(h): State<Arc<Host>>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult {
    call(h, "reviewQueue", json!({"studySet":query.get("studySet")})).await
}
async fn import_book(State(h): State<Arc<Host>>, mut form: Multipart) -> ApiResult {
    use tokio::io::AsyncWriteExt;
    let Some(mut field) = form
        .next_field()
        .await
        .map_err(|_| error("invalid_multipart".into()))?
    else {
        return Err(error("book_file_required".into()));
    };
    let extension = std::path::Path::new(field.file_name().unwrap_or(""))
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["pdf", "epub", "mobi", "azw", "azw3", "fb2", "txt"].contains(&extension.as_str()) {
        return Err(error("unsupported_format".into()));
    }
    let directory = tempfile::tempdir().map_err(|_| error("upload_storage_failed".into()))?;
    let filename = field
        .file_name()
        .unwrap_or("")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    if filename.is_empty()
        || filename.len() > 200
        || filename
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return Err(error("invalid_filename".into()));
    }
    let path = directory.path().join(filename);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|_| error("upload_storage_failed".into()))?;
    let mut size = 0usize;
    while let Some(bytes) = field
        .chunk()
        .await
        .map_err(|_| error("invalid_upload".into()))?
    {
        size += bytes.len();
        if size > 512 * 1024 * 1024 {
            return Err(error("book_size_limit".into()));
        }
        file.write_all(&bytes)
            .await
            .map_err(|_| error("upload_storage_failed".into()))?;
    }
    file.sync_all()
        .await
        .map_err(|_| error("upload_storage_failed".into()))?;
    drop(file);
    let workspace = h.workspace.clone();
    let result = h
        .workspace
        .start("import", move |job| {
            let _directory = directory;
            workspace.import(&path, "original", &job)
        })
        .map_err(error)?;
    Ok(Json(result))
}
async fn search(State(h): State<Arc<Host>>, Json(args): Json<Value>) -> ApiResult {
    call(h, "search", args).await
}
async fn ai(State(h): State<Arc<Host>>, Json(args): Json<Value>) -> ApiResult {
    call(h, "ai", args).await
}
async fn job(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    call(h, "job", json!({"id":id})).await
}
async fn cancel_job(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    call(h, "cancelJob", json!({"id":id})).await
}
async fn mcp_http(State(h): State<Arc<Host>>, Json(request): Json<Value>) -> Response {
    match tokio::task::spawn_blocking(move || mcp::dispatch(&h, request)).await {
        Ok(Ok(value)) if value.is_null() => StatusCode::ACCEPTED.into_response(),
        Ok(Ok(value)) => Json(value).into_response(),
        _ => error("invalid_mcp_request".into()).into_response(),
    }
}

mod replication_files;

async fn sync_configuration(State(host): State<Arc<Host>>) -> ApiResult {
    let config = call(host.clone(), "syncConfig", json!({})).await?.0;
    let status = call(host, "syncStatus", json!({})).await?.0;
    Ok(Json(json!({"config":config,"status":status})))
}
async fn sync_peer(State(host): State<Arc<Host>>, Json(args): Json<Value>) -> ApiResult {
    call(host, "saveSyncPeer", args).await
}
async fn sync_pause(State(host): State<Arc<Host>>, Json(args): Json<Value>) -> ApiResult {
    call(host, "pauseSync", args).await
}
async fn sync_request(State(host): State<Arc<Host>>) -> ApiResult {
    call(host, "requestSync", json!({})).await
}
async fn sync_remove(
    State(host): State<Arc<Host>>,
    Path(id): Path<String>,
    Json(mut args): Json<Value>,
) -> ApiResult {
    if !args.is_object() {
        return Err(error("invalid_sync_configuration".into()));
    }
    args["id"] = json!(id);
    call(host, "removeSyncPeer", args).await
}
