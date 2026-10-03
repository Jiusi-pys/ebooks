use crate::{sync_v2::error, Host};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde_json::{json, Value};
use shufang_application::{BlobManifest, CHUNK_SIZE, MAX_BLOB_SIZE};
use shufang_native::sync_blobs::BlobStore;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
type Api = Result<Json<Value>, (StatusCode, Json<Value>)>;
pub fn router() -> Router<Arc<Host>> {
    Router::new()
        .route("/api/v2/blobs/uploads", post(create))
        .route("/api/v2/blobs/uploads/{id}", get(status))
        .route("/api/v2/blobs/uploads/{id}/{index}", put(chunk))
        .route("/api/v2/blobs/uploads/{id}/commit", post(commit))
        .route("/api/v2/blobs/{hash}", get(download))
        .route("/api/v2/blobs/{hash}/chunks/{index}", get(download_chunk))
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, (StatusCode, Json<Value>)> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| error("blob_worker_failed".into()))?
        .map_err(blob_error)
}
fn blob_error(e: String) -> (StatusCode, Json<Value>) {
    let status = match e.as_str() {
        "upload_not_found" | "blob_not_found" => StatusCode::NOT_FOUND,
        "missing_chunks" => StatusCode::CONFLICT,
        "chunk_checksum_mismatch" | "file_checksum_mismatch" => StatusCode::UNPROCESSABLE_ENTITY,
        _ if e.starts_with("blob_io:") => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(json!({"error":e})))
}
fn store(h: &Host) -> BlobStore {
    BlobStore::new(&h.workspace.root.join("sync-blobs"))
}
async fn create(
    State(h): State<Arc<Host>>,
    Json(manifest): Json<BlobManifest>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let result = blocking(move || {
        serde_json::to_value(store(&h).create(&manifest)?)
            .map_err(|_| "invalid_blob_manifest".into())
    })
    .await?;
    Ok((StatusCode::CREATED, Json(result)))
}
async fn status(State(h): State<Arc<Host>>, Path(id): Path<String>) -> Api {
    Ok(Json(
        blocking(move || {
            serde_json::to_value(store(&h).status(&id)?).map_err(|_| "invalid_blob_manifest".into())
        })
        .await?,
    ))
}
async fn chunk(
    State(h): State<Arc<Host>>,
    Path((id, index)): Path<(String, u64)>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Api {
    if bytes.len() > CHUNK_SIZE as usize {
        return Err(blob_error("invalid_chunk".into()));
    }
    let hash = headers
        .get("x-chunk-sha256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    blocking(move || store(&h).put(&id, index, &bytes, &hash)).await?;
    Ok(Json(json!({"ok":true})))
}
async fn commit(State(h): State<Arc<Host>>, Path(id): Path<String>) -> Api {
    Ok(Json(
        blocking(move || {
            serde_json::to_value(store(&h).commit(&id)?).map_err(|_| "invalid_blob_manifest".into())
        })
        .await?,
    ))
}
async fn open(h: &Host, hash: &str) -> Result<tokio::fs::File, (StatusCode, Json<Value>)> {
    let path = store(h).path(hash).map_err(blob_error)?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| blob_error("blob_not_found".into()))?;
    if file
        .metadata()
        .await
        .map_err(|_| blob_error("blob_io: metadata".into()))?
        .len()
        > MAX_BLOB_SIZE
    {
        return Err(blob_error("invalid_blob_size".into()));
    }
    Ok(file)
}
async fn download(
    State(h): State<Arc<Host>>,
    Path(hash): Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let file = open(&h, &hash).await?;
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        let mut bytes = vec![0u8; CHUNK_SIZE as usize];
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
        Body::from_stream(stream),
    )
        .into_response())
}
async fn download_chunk(
    State(h): State<Arc<Host>>,
    Path((hash, index)): Path<(String, u64)>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if index >= MAX_BLOB_SIZE / CHUNK_SIZE {
        return Err(blob_error("invalid_chunk".into()));
    }
    let mut file = open(&h, &hash).await?;
    file.seek(std::io::SeekFrom::Start(index * CHUNK_SIZE))
        .await
        .map_err(|_| blob_error("blob_io: seek".into()))?;
    let mut bytes = vec![];
    file.take(CHUNK_SIZE)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| blob_error("blob_io: read".into()))?;
    Ok(([("content-type", "application/octet-stream")], bytes).into_response())
}
