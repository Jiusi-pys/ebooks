pub mod ai_rpc;
pub mod browser_auth;
pub mod browser_session;
pub mod codex_auth;
pub mod credentials;

pub mod legacy;
mod legacy_validation;
mod library;
pub mod mcp;
mod mcp_users;
pub mod oauth;
pub mod oauth_migration;
pub mod peer_migration;
mod reader_event;
pub mod replication;
mod server_startup;
mod sync_blobs;
mod sync_openapi;
pub mod sync_v2;
mod trpc;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum V1Contract {
    Mirror,
    SyncEntities,
}
pub struct Host {
    pub workspace: Arc<Workspace>,
    pub token: String,
    pub machine_key: Option<String>,
    pub oauth_enabled: bool,
    pub oauth_redirects: Option<Vec<String>>,
    pub codex: Arc<codex_auth::Controller>,
    pub ai_executor: Arc<dyn ai_rpc::Executor>,
    pub ai_slots: Arc<tokio::sync::Semaphore>,
    pub base_url: String,
    pub stop: tokio::sync::Notify,
    read_only: bool,
    pub v1_contract: V1Contract,
    pub browser: Option<Arc<browser_auth::Auth>>,
}
impl Host {
    pub fn new(workspace: Arc<Workspace>, token: String, base_url: String) -> Arc<Self> {
        Self::new_mode(workspace, token, base_url, false)
    }
    pub fn new_read_only(workspace: Arc<Workspace>, token: String, base_url: String) -> Arc<Self> {
        Self::new_mode(workspace, token, base_url, true)
    }
    fn new_mode(
        workspace: Arc<Workspace>,
        token: String,
        base_url: String,
        read_only: bool,
    ) -> Arc<Self> {
        Self::with_contract(workspace, token, base_url, read_only, V1Contract::Mirror)
    }
    pub fn with_contract(
        workspace: Arc<Workspace>,
        token: String,
        base_url: String,
        read_only: bool,
        v1_contract: V1Contract,
    ) -> Arc<Self> {
        Arc::new(Self {
            workspace,
            machine_key: Some(token.clone()),
            oauth_enabled: true,
            oauth_redirects: None,
            codex: codex_auth::Controller::new(),
            ai_executor: Arc::new(ai_rpc::NativeExecutor),
            ai_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            token,
            base_url: base_url.trim_end_matches('/').into(),
            stop: tokio::sync::Notify::new(),
            read_only,
            v1_contract,
            browser: None,
        })
    }
    pub fn is_read_only(&self) -> bool {
        self.read_only
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
        .route(
            "/api/v1/books/{id}/state",
            get(legacy::reader_state).patch(legacy::book_state),
        )
        .route("/api/v1/books/{id}/source", get(library::source))
        .route(
            "/api/v1/books/{id}/source/chunks",
            axum::routing::put(library::source_chunk),
        )
        .route(
            "/api/v1/books/{id}/source/complete",
            post(library::source_complete),
        )
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
            "/api/native/v1/versions",
            get(list_versions).post(create_version),
        )
        .route("/api/native/v1/versions/{id}", delete(delete_version))
        .route(
            "/api/native/v1/versions/{id}/restore",
            post(restore_version),
        )
        .route(
            "/api/native/v1/versions/{version}/entities/{kind}/{id}/restore",
            post(restore_version_entity),
        )
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
        .merge(oauth::router(host.clone()))
        .merge(browser_auth::router())
        .merge(library::router(host.clone()))
        .merge(server_startup::router(host.clone()))
        .merge(codex_auth::router(host.clone()))
        .merge(trpc::router())
        .route("/api/v1/", get(legacy::directory))
        .route("/api/v1", get(legacy::directory))
        .route(
            "/health",
            get(|State(host): State<Arc<Host>>| async move {
                Json(json!({"ok":true,"readOnly":host.is_read_only()}))
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(host.clone(), write_fence))
        .with_state(host)
}
async fn write_fence(State(host): State<Arc<Host>>, request: Request, next: Next) -> Response {
    let safe = matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    );
    let read_only_mcp =
        request.method() == axum::http::Method::POST && request.uri().path() == "/mcp";
    if host.is_read_only()
        && ((!safe && !read_only_mcp) || request.uri().path().starts_with("/oauth/"))
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"read_only_replica"})),
        )
            .into_response();
    }
    next.run(request).await
}
async fn authorize(State(host): State<Arc<Host>>, request: Request, next: Next) -> Response {
    if request.uri().path() == "/mcp" {
        if let Some(origin) = request.headers().get(axum::http::header::ORIGIN) {
            let valid = origin.to_str().ok().is_some_and(|origin| {
                let parsed = url::Url::parse(origin).ok();
                let public = url::Url::parse(&host.base_url).ok();
                match (parsed, public) {
                    (Some(parsed), Some(public)) => {
                        parsed.origin() == public.origin()
                            && parsed.origin().ascii_serialization() == origin
                    }
                    _ => false,
                }
            });
            if !valid {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"invalid_origin"})),
                )
                    .into_response();
            }
        }
    }
    let public_machine =
        request.uri().path() == "/mcp" || request.uri().path().starts_with("/api/v1/");
    let key = request
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    if request.method() == axum::http::Method::POST
        && request.uri().path() == "/api/v1/events"
        && key.trim().is_empty()
        && !request.headers().contains_key("authorization")
    {
        return library::authorize(State(host), request, next).await;
    }
    if public_machine && host.machine_key.is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"machine_api_unavailable"})),
        )
            .into_response();
    }
    if !key.is_empty()
        && (same_secret(key, &host.token)
            || (public_machine
                && host
                    .machine_key
                    .as_ref()
                    .is_some_and(|expected| same_secret(key, expected))))
    {
        return next.run(request).await;
    }
    let token = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.get(..7)
                .filter(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
                .map(|_| s[7..].trim())
        });
    if let Some(token) = token {
        if same_secret(token, &host.token)
            || (public_machine
                && host
                    .machine_key
                    .as_ref()
                    .is_some_and(|expected| same_secret(token, expected)))
        {
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
        "csrf_rejected" => StatusCode::FORBIDDEN,
        "ai_not_configured" | "model_not_selected" | "codex_unavailable" | "sync_field_pending" => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        "not_found" | "entity_deleted" => StatusCode::NOT_FOUND,
        "revision_conflict"
        | "operation_id_reused"
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
async fn list_versions(State(h): State<Arc<Host>>) -> ApiResult {
    call(h, "listVersions", json!({})).await
}
async fn create_version(State(h): State<Arc<Host>>) -> ApiResult {
    call(h, "createVersion", json!({})).await
}
async fn delete_version(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    call(h, "deleteVersion", json!({"id":id})).await
}
async fn restore_version(
    State(h): State<Arc<Host>>,
    Path(id): Path<String>,
    input: Option<Json<Value>>,
) -> ApiResult {
    let mut input = input.map(|v| v.0).unwrap_or(json!({}));
    if !input.is_object() {
        return Err(error("invalid_restore_request".into()));
    }
    input["id"] = id.into();
    call(h, "restoreVersion", input).await
}
async fn restore_version_entity(
    State(h): State<Arc<Host>>,
    Path((version, kind, id)): Path<(String, String, String)>,
    Json(mut input): Json<Value>,
) -> ApiResult {
    input["version"] = version.into();
    input["kind"] = kind.into();
    input["id"] = id.into();
    call(h, "restoreVersionEntity", input).await
}
async fn mcp_http(
    State(h): State<Arc<Host>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let envelope_version = &request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"];
    let modern = request["method"] == "server/discover"
        || envelope_version == "2026-07-28"
        || headers
            .get("MCP-Protocol-Version")
            .is_some_and(|value| value == "2026-07-28");
    if modern {
        let method = request["method"].as_str().unwrap_or("");
        let version_matches = headers
            .get("MCP-Protocol-Version")
            .is_some_and(|value| value == "2026-07-28");
        let method_matches = headers
            .get("Mcp-Method")
            .is_some_and(|value| value == method);
        let name_matches = if method == "tools/call" {
            request["params"]["name"]
                .as_str()
                .is_some_and(|name| headers.get("Mcp-Name").is_some_and(|value| value == name))
        } else {
            true
        };
        if !version_matches || envelope_version != "2026-07-28" || !method_matches || !name_matches
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"jsonrpc":"2.0","id":request.get("id"),"error":{"code":-32020,"message":"MCP routing header mismatch"}})),
            )
                .into_response();
        }
    }
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.get(..7)
                .filter(|p| p.eq_ignore_ascii_case("Bearer "))
                .map(|_| v[7..].trim())
        })
        .unwrap_or("");
    let key = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    let privileged = [bearer, key].into_iter().any(|v| {
        !v.is_empty()
            && (same_secret(v, &h.token)
                || h.machine_key.as_ref().is_some_and(|k| same_secret(v, k)))
    });
    let access = if privileged
        || oauth::access_scope(&h, bearer)
            .ok()
            .flatten()
            .is_some_and(|s| s.split_whitespace().any(|s| s == "library:write"))
    {
        mcp::Access::Write
    } else {
        mcp::Access::Read
    };
    if access == mcp::Access::Read
        && request["method"] == "tools/call"
        && mcp_users::catalogue()
            .into_iter()
            .any(|s| s.write && Some(s.name.as_str()) == request["params"]["name"].as_str())
    {
        return (StatusCode::FORBIDDEN,[("WWW-Authenticate",format!("Bearer error=\"insufficient_scope\", scope=\"library:read library:write\", resource_metadata=\"{}/.well-known/oauth-protected-resource\"",h.base_url))],Json(json!({"error":"insufficient_scope"}))).into_response();
    }
    match mcp::dispatch_async(h, request, access).await {
        Ok(value) if value.is_null() => StatusCode::ACCEPTED.into_response(),
        Ok(value) => Json(value).into_response(),
        _ => error("invalid_mcp_request".into()).into_response(),
    }
}

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
