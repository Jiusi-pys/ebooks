use serde_json::json;

#[tokio::test]
async fn bootstrap_reads_snapshot_only_state_without_inventing_original_operations() {
    use shufang_application::{
        incoming_snapshot::{IncomingSnapshot, SnapshotPage},
        LocalCommit,
    };
    use shufang_domain::lossless_sync::{ReplicaOperation, ReplicaState};
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let wa = Workspace::open(&a.path().join("library.sqlite3"), "w", "a").unwrap();
    let wb = Workspace::open(&b.path().join("library.sqlite3"), "w", "b").unwrap();
    let operation=ReplicaOperation::parse(r#"{"workspaceId":"w","replicaId":"original","operationId":"unavailable-original","kind":"notes","entityId":"snapshot-only","clock":"5:0","patch":{"title":"Snapshot","content":"state without original log","createdAt":1,"updatedAt":1}}"#).unwrap();
    {
        let mut core = wb.core.lock().unwrap();
        core.begin_incoming_snapshot(
            &IncomingSnapshot::new("restored", "source", "epoch", "watermark", 1).unwrap(),
        )
        .unwrap();
        core.stage_incoming_snapshot(
            "restored",
            "source",
            &SnapshotPage {
                index: 0,
                after: "".into(),
                next: None,
                states: vec![ReplicaState::apply(None, &operation).unwrap()],
            },
        )
        .unwrap();
        core.finish_incoming_snapshot(
            "restored",
            "source",
            &LocalCommit {
                key: "sync:restored".into(),
                expected: 0,
                value: json!("watermark"),
            },
        )
        .unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hb = Host::new(wb.clone(), "owner-b".into(), format!("http://{address}"));
    let server = tokio::spawn(async move { axum::serve(listener, router(hb)).await.unwrap() });
    let ha = Host::new(wa.clone(), "owner-a".into(), "http://localhost".into());
    let peer = Peer {
        id: "b".into(),
        url: format!("http://{address}"),
        token: "owner-b".into(),
    };
    tick_peer(&ha, &peer).await.unwrap();
    assert_eq!(
        wa.core
            .lock()
            .unwrap()
            .entity("notes", "snapshot-only")
            .unwrap()
            .value["content"],
        "state without original log"
    );
    assert!(wa
        .core
        .lock()
        .unwrap()
        .replication_operations(0, 100)
        .unwrap()
        .is_empty());
    server.abort();
}
use shufang_native::workspace::Workspace;
use shufang_service::{
    replication::{tick_peer, Peer},
    router, Host,
};
#[tokio::test]
async fn externalized_business_write_crosses_http_and_survives_restart() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let path = a.path().join("library.sqlite3");
    let wa = Workspace::open(&path, "w", "a").unwrap();
    let wb = Workspace::open(&b.path().join("library.sqlite3"), "w", "b").unwrap();
    let content = "真实多分片正文😀".repeat(40000);
    wb.core
        .lock()
        .unwrap()
        .save_note("large", "Large", &content, 0)
        .unwrap();
    let original = wb
        .core
        .lock()
        .unwrap()
        .replication_operations(0, 100)
        .unwrap()[0]
        .operation
        .clone();
    assert!(original.patch["content"].get("$blob").is_some());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hb = Host::new(wb.clone(), "owner-b".into(), format!("http://{address}"));
    let server = tokio::spawn(async move { axum::serve(listener, router(hb)).await.unwrap() });
    let peer = Peer {
        id: "b".into(),
        url: format!("http://{address}"),
        token: "owner-b".into(),
    };
    {
        let ha = Host::new(wa.clone(), "owner-a".into(), "http://localhost".into());
        tick_peer(&ha, &peer).await.unwrap();
        tick_peer(&ha, &peer).await.unwrap();
        assert_eq!(
            wa.core
                .lock()
                .unwrap()
                .entity("notes", "large")
                .unwrap()
                .value["content"],
            content
        );
        assert_eq!(
            wa.core
                .lock()
                .unwrap()
                .replication_operations(0, 100)
                .unwrap()[0]
                .operation,
            original
        );
    }
    drop(wa);
    let reopened = Workspace::open(&path, "w", "a").unwrap();
    assert_eq!(
        reopened
            .core
            .lock()
            .unwrap()
            .entity("notes", "large")
            .unwrap()
            .value["content"],
        content
    );
    assert_eq!(
        reopened
            .core
            .lock()
            .unwrap()
            .replication_operations(0, 100)
            .unwrap()[0]
            .operation,
        original
    );
    server.abort();
}
#[tokio::test]
async fn actual_http_two_independent_databases_converge_and_retry_offline() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let wa = Workspace::open(&a.path().join("library.sqlite3"), "w", "a").unwrap();
    let wb = Workspace::open(&b.path().join("library.sqlite3"), "w", "b").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hb = Host::new(wb.clone(), "owner-b".into(), format!("http://{address}"));
    let server = tokio::spawn(async move { axum::serve(listener, router(hb)).await.unwrap() });
    let ha = Host::new(wa.clone(), "owner-a".into(), "http://127.0.0.1:1".into());
    let peer = Peer {
        id: "b".into(),
        url: format!("http://{address}"),
        token: "owner-b".into(),
    };
    wa.core
        .lock()
        .unwrap()
        .save_note("from-a", "A", "offline", 0)
        .unwrap();
    wb.core
        .lock()
        .unwrap()
        .save_note("from-b", "B", "remote", 0)
        .unwrap();
    tick_peer(&ha, &peer).await.unwrap();
    tick_peer(&ha, &peer).await.unwrap();
    for workspace in [&wa, &wb] {
        let core = workspace.core.lock().unwrap();
        assert_eq!(core.entities("notes").unwrap().len(), 2);
        assert_eq!(core.replication_operations(0, 100).unwrap().len(), 2);
    }
    server.abort();
    let _ = server.await;
    wa.core
        .lock()
        .unwrap()
        .save_entity(
            "notes",
            "from-a",
            json!({"content":"edited offline"}),
            vec![],
            1,
        )
        .unwrap();
    assert!(tick_peer(&ha, &peer).await.is_err());
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let hb = Host::new(wb.clone(), "owner-b".into(), format!("http://{address}"));
    let server = tokio::spawn(async move { axum::serve(listener, router(hb)).await.unwrap() });
    tick_peer(&ha, &peer).await.unwrap();
    assert_eq!(
        wb.core
            .lock()
            .unwrap()
            .entity("notes", "from-a")
            .unwrap()
            .value["content"],
        "edited offline"
    );
    server.abort();
}

#[tokio::test]
async fn referenced_files_cross_actual_http_both_directions_and_retry_missing_bytes() {
    use sha2::{Digest, Sha256};
    use shufang_application::BlobManifest;
    use shufang_native::sync_blobs::BlobStore;
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let wa = Workspace::open(&a.path().join("library.sqlite3"), "w", "a").unwrap();
    let wb = Workspace::open(&b.path().join("library.sqlite3"), "w", "b").unwrap();
    let bytes = vec![23u8; 256 * 1024 + 17];
    let manifest = BlobManifest {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        size: bytes.len() as u64,
        name: "field.json".into(),
        content_type: "application/json".into(),
    };
    let op:shufang_domain::sync::Operation=serde_json::from_value(json!({"workspaceId":"w","operationId":"file-note","replicaId":"b","entityId":"n","kind":"notes","clock":"100:0","patch":{"content":{"$blob":manifest}},"unset":[],"deleted":false})).unwrap();
    wb.core
        .lock()
        .unwrap()
        .receive_operations(&[op], None)
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hb = Host::new(wb.clone(), "owner-b".into(), format!("http://{address}"));
    let server = tokio::spawn(async move { axum::serve(listener, router(hb)).await.unwrap() });
    let ha = Host::new(wa.clone(), "owner-a".into(), "http://127.0.0.1:1".into());
    let peer = Peer {
        id: "b".into(),
        url: format!("http://{address}"),
        token: "owner-b".into(),
    };
    assert!(
        tick_peer(&ha, &peer).await.is_err(),
        "missing file must be pending"
    );
    assert!(
        wa.core
            .lock()
            .unwrap()
            .entity_metadata("notes", "n")
            .is_ok(),
        "metadata must not wait for files"
    );
    let store = BlobStore::new(&wb.root.join("sync-blobs"));
    let id = store.create(&manifest).unwrap().id;
    for (i, chunk) in bytes.chunks(256 * 1024).enumerate() {
        store
            .put(
                &id,
                i as u64,
                chunk,
                &format!("{:x}", Sha256::digest(chunk)),
            )
            .unwrap();
    }
    store.commit(&id).unwrap();
    tick_peer(&ha, &peer).await.unwrap();
    let local = BlobStore::new(&wa.root.join("sync-blobs"));
    assert_eq!(
        std::fs::read(local.path(&manifest.sha256).unwrap()).unwrap(),
        bytes
    );
    // Simulate remote object loss: the next pass uploads verified local content.
    std::fs::remove_file(store.path(&manifest.sha256).unwrap()).unwrap();
    tick_peer(&ha, &peer).await.unwrap();
    assert_eq!(
        std::fs::read(store.path(&manifest.sha256).unwrap()).unwrap(),
        bytes
    );
    tick_peer(&ha, &peer).await.unwrap();
    assert_eq!(
        wa.core
            .lock()
            .unwrap()
            .replication_operations(0, 100)
            .unwrap()
            .len(),
        1
    );
    server.abort();
}

#[tokio::test]
async fn missing_external_credentials_are_visible_without_leaking_reference_or_token() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("library.sqlite3"), "w", "a").unwrap();
    let missing = format!(
        "SHUFANG_MISSING_{}",
        uuid::Uuid::new_v4().simple().to_string().to_uppercase()
    );
    w.execute("saveSyncPeer",json!({"expected":0,"id":"b","url":"https://books.example.test","tokenEnvironment":missing})).unwrap();
    w.execute("pauseSync", json!({"expected":1,"paused":false}))
        .unwrap();
    let host = Host::new(w.clone(), "owner".into(), "http://localhost".into());
    let worker = tokio::spawn(shufang_service::replication::run(host));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    let status = loop {
        let status = w.execute("syncStatus", json!({})).unwrap();
        if status["worker"]["error"].is_string() {
            break status;
        }
        if tokio::time::Instant::now() > deadline {
            worker.abort();
            panic!("configuration failure is not visible");
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    worker.abort();
    let _ = worker.await;
    assert_eq!(status["worker"]["error"], "sync_configuration_unavailable");
    assert!(!status.to_string().contains(&missing));
    assert_eq!(w.core.lock().unwrap().pending().unwrap().len(), 0);
}
