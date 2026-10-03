//! Bounded resumable v2 file transport. Metadata commits independently of bytes.
use crate::{
    replication::{json_response, Peer},
    Host,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_application::{BlobManifest, CHUNK_SIZE};
use shufang_native::sync_blobs::BlobStore;
use std::{collections::BTreeMap, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

fn request(
    client: &reqwest::Client,
    peer: &Peer,
    workspace: &str,
    method: reqwest::Method,
    path: &str,
) -> reqwest::RequestBuilder {
    client
        .request(
            method,
            format!("{}/api/v2{path}", peer.url.trim_end_matches('/')),
        )
        .bearer_auth(&peer.token)
        .header("X-Workspace-Id", workspace)
}
fn checkpoint(host: &Host, key: &str) -> Result<(u64, Value), String> {
    host.workspace
        .core
        .lock()
        .map_err(|_| "core_lock_failed")?
        .sync_checkpoint(key)
}
fn save(host: &Host, key: &str, expected: u64, value: Value) -> Result<(), String> {
    host.workspace
        .core
        .lock()
        .map_err(|_| "core_lock_failed")?
        .set_local_value(key, expected, &value)?;
    Ok(())
}
async fn send(req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    req.send()
        .await
        .map_err(|_| "sync_file_transport_failed".into())
}
fn manifest(value: Value) -> Result<BlobManifest, String> {
    let result: BlobManifest =
        serde_json::from_value(value).map_err(|_| "invalid_blob_manifest")?;
    result.validate()?;
    Ok(result)
}
pub async fn transfer(
    host: &Arc<Host>,
    peer: &Peer,
    client: &reqwest::Client,
    workspace: &str,
    identity: &str,
) -> Result<(), String> {
    let store = BlobStore::new(&host.workspace.root.join("sync-blobs"));
    let mut after = String::new();
    let mut seen = BTreeMap::<String, BlobManifest>::new();
    loop {
        let states = host
            .workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .replication_entities(None, &after)?;
        for state in &states {
            if state.deleted {
                continue;
            }
            if state.kind == "sources" {
                if let Some(value) = shufang_domain::sync::materialize(state)? {
                    let m = manifest(value)?;
                    seen.insert(m.sha256.clone(), m);
                }
            }
            for field in state.fields.values().filter(|f| !f.removed) {
                if let Some(value) = &field.value {
                    if let Some(reference) = value.get("$blob") {
                        let m = manifest(reference.clone())?;
                        seen.insert(m.sha256.clone(), m);
                    }
                }
            }
        }
        if states.len() < 100 {
            break;
        }
        let last = states.last().ok_or("sync_entities_stalled")?;
        let next = format!("{}:{}", last.kind, last.id);
        if after == next {
            return Err("sync_entities_stalled".into());
        }
        after = next;
    }
    let mut pending = 0usize;
    for m in seen.values() {
        let result = if store.has(&m.sha256)? {
            upload(host, peer, client, workspace, identity, &store, m).await
        } else {
            download(host, peer, client, workspace, &store, m).await
        };
        if result.is_err() {
            pending += 1;
        }
    }
    if pending > 0 {
        Err(format!("sync_files_pending:{pending}"))
    } else {
        Ok(())
    }
}
async fn upload(
    host: &Host,
    peer: &Peer,
    client: &reqwest::Client,
    workspace: &str,
    identity: &str,
    store: &BlobStore,
    m: &BlobManifest,
) -> Result<(), String> {
    let key = format!("sync:upload:{identity}:{}", m.sha256);
    let (revision, previous) = checkpoint(host, &key)?;
    let mut progress = None;
    let mut id = None;
    if let Some(old) = previous.as_str() {
        if uuid::Uuid::parse_str(old).is_err() {
            return Err("invalid_upload_id".into());
        }
        let response = send(request(
            client,
            peer,
            workspace,
            reqwest::Method::GET,
            &format!("/blobs/uploads/{old}"),
        ))
        .await?;
        if response.status() != reqwest::StatusCode::NOT_FOUND {
            progress = Some(json_response(response).await?);
            id = Some(old.to_owned());
        }
    }
    let id = match id {
        Some(id) => id,
        None => {
            let response = json_response(
                send(
                    request(
                        client,
                        peer,
                        workspace,
                        reqwest::Method::POST,
                        "/blobs/uploads",
                    )
                    .json(m),
                )
                .await?,
            )
            .await?;
            let id = response["id"]
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .ok_or("invalid_upload_id")?
                .to_owned();
            save(host, &key, revision, json!(id))?;
            id
        }
    };
    let progress = match progress {
        Some(p) => p,
        None => {
            json_response(
                send(request(
                    client,
                    peer,
                    workspace,
                    reqwest::Method::GET,
                    &format!("/blobs/uploads/{id}"),
                ))
                .await?,
            )
            .await?
        }
    };
    let remote = manifest(progress["manifest"].clone())?;
    if remote.sha256 != m.sha256 || remote.size != m.size {
        return Err("invalid_peer_upload_progress".into());
    }
    let missing = progress["missing"]
        .as_array()
        .filter(|v| v.len() <= 1024)
        .ok_or("invalid_peer_upload_progress")?;
    let mut file = tokio::fs::File::open(store.path(&m.sha256)?)
        .await
        .map_err(|_| "local_blob_missing")?;
    for index in missing {
        let index = index.as_u64().ok_or("invalid_chunk")?;
        let length = m.chunk_length(index)?;
        let mut bytes = vec![0u8; length as usize];
        file.seek(std::io::SeekFrom::Start(index * CHUNK_SIZE))
            .await
            .map_err(|_| "local_blob_read_failed")?;
        file.read_exact(&mut bytes)
            .await
            .map_err(|_| "local_blob_read_failed")?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let response = send(
            request(
                client,
                peer,
                workspace,
                reqwest::Method::PUT,
                &format!("/blobs/uploads/{id}/{index}"),
            )
            .header("Content-Type", "application/octet-stream")
            .header("X-Chunk-SHA256", hash)
            .body(bytes),
        )
        .await?;
        if !response.status().is_success() {
            return Err(format!("sync_file_http_{}", response.status().as_u16()));
        }
    }
    let committed = manifest(
        json_response(
            send(request(
                client,
                peer,
                workspace,
                reqwest::Method::POST,
                &format!("/blobs/uploads/{id}/commit"),
            ))
            .await?,
        )
        .await?,
    )?;
    if committed.sha256 != m.sha256 || committed.size != m.size {
        return Err("invalid_peer_file_acknowledgement".into());
    }
    Ok(())
}
async fn download(
    host: &Host,
    peer: &Peer,
    client: &reqwest::Client,
    workspace: &str,
    store: &BlobStore,
    m: &BlobManifest,
) -> Result<(), String> {
    let key = format!("sync:download:{}", m.sha256);
    let (revision, previous) = checkpoint(host, &key)?;
    let id = match previous.as_str().filter(|id| store.status(id).is_ok()) {
        Some(id) => id.to_owned(),
        None => {
            let id = store.create(m)?.id;
            save(host, &key, revision, json!(id))?;
            id
        }
    };
    let progress = store.status(&id)?;
    if progress.manifest.sha256 != m.sha256 || progress.manifest.size != m.size {
        return Err("invalid_blob_manifest".into());
    }
    for index in progress.missing {
        let mut response = send(request(
            client,
            peer,
            workspace,
            reqwest::Method::GET,
            &format!("/blobs/{}/chunks/{index}", m.sha256),
        ))
        .await?;
        if !response.status().is_success() {
            return Err(format!("sync_file_http_{}", response.status().as_u16()));
        }
        let expected = m.chunk_length(index)? as usize;
        if response
            .content_length()
            .is_some_and(|n| n != expected as u64)
        {
            return Err("invalid_peer_chunk_size".into());
        }
        let mut bytes = Vec::with_capacity(expected);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "sync_file_read_failed")?
        {
            if bytes.len() + chunk.len() > expected {
                return Err("invalid_peer_chunk_size".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        store.put(&id, index, &bytes, &format!("{:x}", Sha256::digest(&bytes)))?;
    }
    store.commit(&id)?;
    Ok(())
}
