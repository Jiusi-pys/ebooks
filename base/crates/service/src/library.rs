//! Browser-only book projection over the same authoritative repository.
use crate::{call, error, ApiResult, Host};
use axum::{
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
pub fn router(host: Arc<Host>) -> Router<Arc<Host>> {
    Router::new()
        .route("/api/library/books", get(books).post(create))
        .route(
            "/api/library/books/{id}",
            get(book).patch(state).delete(remove),
        )
        .route("/api/library/books/{id}/source", get(source))
        .route(
            "/api/library/books/{id}/source/chunks",
            axum::routing::put(source_chunk),
        )
        .route(
            "/api/library/books/{id}/source/complete",
            axum::routing::post(source_complete),
        )
        .route("/api/library/books/{id}/state", get(book).patch(state))
        .layer(middleware::from_fn_with_state(host, authorize))
}
pub(crate) async fn authorize(
    State(host): State<Arc<Host>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(auth) = host.browser.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"auth_not_configured"})),
        )
            .into_response();
    };
    let headers = request.headers().clone();
    let mutation = !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    let result = tokio::task::spawn_blocking(move || {
        auth.validate(&headers, true)?;
        if mutation && !auth.same_origin(&headers) {
            return Err("csrf_rejected".into());
        }
        Ok::<(), String>(())
    })
    .await;
    let mut response = match result {
        Ok(Ok(())) => next.run(request).await,
        Ok(Err(code)) => {
            let status = match code.as_str() {
                "unauthorized" => StatusCode::UNAUTHORIZED,
                "setup_required" => StatusCode::PRECONDITION_REQUIRED,
                "csrf_rejected" => StatusCode::FORBIDDEN,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            (status, Json(json!({"error":code}))).into_response()
        }
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"account_store_unavailable"})),
        )
            .into_response(),
    };
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}
async fn books(State(host): State<Arc<Host>>) -> ApiResult {
    tokio::task::spawn_blocking(move||{
        let core=host.workspace.core.lock().map_err(|_|error("core_lock_failed".into()))?;
        let records=core.entities("books").map_err(error)?;
        if records.iter().any(|r|!r.pending_fields.is_empty()) {return Err(error("sync_field_pending".into()));}
        let folders=core.entities("folders").map_err(error)?;
        let mut deleted=Vec::new();let mut after=String::new();
        loop {
            let page=core.replication_entities(Some("books"),&after).map_err(error)?;
            for state in &page {if state.deleted {deleted.push(state.id.clone());}}
            if page.len()<100 {break;}
            let last=page.last().ok_or_else(||error("invalid_entity_page".into()))?;
            after=format!("{}:{}",last.kind,last.id);
        }
        Ok(Json(json!({"books":records.iter().map(|r|json!({"id":r.value["id"],"hasReaderData":true,"source":null})).collect::<Vec<_>>(),"deletedBookIds":deleted,"folders":folders.into_iter().map(|r|r.value).collect::<Vec<_>>()})))
    }).await.map_err(|_|error("library_unavailable".into()))?
}
async fn book(State(host): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let Json(record) = call(host, "get", json!({"kind":"books","id":id})).await?;
    if record["pendingFields"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        return Err(error("sync_field_pending".into()));
    }
    Ok(Json(json!({"book":record["value"],"source":null})))
}
async fn state(
    State(host): State<Arc<Host>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ApiResult {
    crate::legacy::sync_mutation_source(
        host, "books", &id, &headers, &input, false, false, "reader",
    )
    .await
}

pub(crate) async fn source_chunk(
    State(host): State<Arc<Host>>,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> ApiResult {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let _ = call(host.clone(), "get", json!({"kind":"books","id":id})).await?;
    let hash = input["uploadId"]
        .as_str()
        .ok_or_else(|| error("invalid_source_upload".into()))?
        .to_owned();
    let index = input["index"]
        .as_u64()
        .ok_or_else(|| error("invalid_chunk".into()))?;
    let encoded = input["payload"]
        .as_str()
        .filter(|s| s.len() <= 350000)
        .ok_or_else(|| error("invalid_chunk".into()))?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| error("invalid_chunk".into()))?;
    if STANDARD.encode(&bytes) != encoded {
        return Err(error("invalid_chunk".into()));
    }
    tokio::task::spawn_blocking(move || {
        shufang_native::sync_blobs::BlobStore::new(&host.workspace.root.join("sync-blobs"))
            .stage_legacy(&id, &hash, index, &bytes)
    })
    .await
    .map_err(|_| error("library_unavailable".into()))?
    .map_err(error)?;
    Ok(Json(json!({"ok":true})))
}
pub(crate) async fn source_complete(
    State(host): State<Arc<Host>>,
    Path(id): Path<String>,
    Json(mut input): Json<Value>,
) -> ApiResult {
    use sha2::{Digest, Sha256};
    let Json(book) = call(host.clone(), "get", json!({"kind":"books","id":id})).await?;
    let manifest: shufang_application::BlobManifest = serde_json::from_value(input.clone())
        .map_err(|_| error("invalid_source_manifest".into()))?;
    manifest.validate().map_err(error)?;
    if manifest.size == 0
        || manifest.name.is_empty()
        || input["uploadId"] != manifest.sha256
        || input["chunks"].as_u64() != Some(manifest.size.div_ceil(shufang_application::CHUNK_SIZE))
        || input.as_object().is_none_or(|v| {
            v.keys().any(|k| {
                !["uploadId", "chunks", "sha256", "size", "name", "type"].contains(&k.as_str())
            })
        })
    {
        return Err(error("invalid_source_manifest".into()));
    }
    let owner = host.clone();
    let book_id = id.clone();
    tokio::task::spawn_blocking(move || {
        shufang_native::sync_blobs::BlobStore::new(&owner.workspace.root.join("sync-blobs"))
            .complete_legacy(&book_id, &manifest)
    })
    .await
    .map_err(|_| error("library_unavailable".into()))?
    .map_err(error)?;
    let operation = format!(
        "source-{:x}",
        Sha256::digest(format!("{id}{}", input["sha256"].as_str().unwrap()).as_bytes())
    );
    input["format"] = book["value"]["format"].clone();
    let _ = call(
        host,
        "mutateReplica",
        json!({"kind":"sources","id":id,"operationId":operation,"patch":input}),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
pub(crate) async fn source(
    State(host): State<Arc<Host>>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    use tokio::io::AsyncReadExt;
    let _ = call(host.clone(), "get", json!({"kind":"books","id":id})).await?;
    let Json(manifest) = call(
        host.clone(),
        "getReplica",
        json!({"kind":"sources","id":id}),
    )
    .await?;
    let hash = manifest["value"]["sha256"]
        .as_str()
        .ok_or_else(|| error("source_not_found".into()))?
        .to_owned();
    let path = tokio::task::spawn_blocking(move || {
        let store =
            shufang_native::sync_blobs::BlobStore::new(&host.workspace.root.join("sync-blobs"));
        if !store.has(&hash)? {
            return Err("source_not_found".to_owned());
        }
        store.path(&hash)
    })
    .await
    .map_err(|_| error("library_unavailable".into()))?
    .map_err(error)?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| error("source_not_found".into()))?;
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        let mut bytes = vec![0u8; shufang_application::CHUNK_SIZE as usize];
        let count = file.read(&mut bytes).await?;
        if count == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            bytes.truncate(count);
            Ok(Some((bytes, file)))
        }
    });
    Ok((
        [("content-type", "application/octet-stream")],
        axum::body::Body::from_stream(stream),
    )
        .into_response())
}

async fn create(
    State(host): State<Arc<Host>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ApiResult {
    let id = input["extId"]
        .as_str()
        .or_else(|| input["id"].as_str())
        .ok_or_else(|| error("invalid_id".into()))?;
    crate::legacy::sync_mutation_source(host, "books", id, &headers, &input, true, false, "reader")
        .await
}
async fn remove(
    State(host): State<Arc<Host>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    crate::legacy::sync_mutation_source(
        host,
        "books",
        &id,
        &headers,
        &json!({}),
        false,
        true,
        "reader",
    )
    .await
}
