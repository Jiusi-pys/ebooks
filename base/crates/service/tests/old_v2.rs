//! Opt-in real MySQL/Hono peer, driven by app/api/sync/native.mysql.test.ts.
use shufang_native::workspace::Workspace;
use shufang_service::{
    replication::{tick_peer, Peer},
    Host,
};
#[tokio::test]
#[ignore = "requires isolated MySQL/Hono peer driven by native.mysql.test.ts"]
async fn old_mysql_v2_and_native_sqlite_exchange_original_operations_and_files() {
    let origin = std::env::var("SHUFANG_OLD_TEST_ORIGIN").expect("isolated fixture required");
    let identity = std::env::var("SHUFANG_OLD_TEST_WORKSPACE").unwrap();
    let token = std::env::var("SHUFANG_OLD_TEST_TOKEN").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let workspace =
        Workspace::open(&dir.path().join("library.sqlite3"), &identity, "native").unwrap();
    workspace
        .core
        .lock()
        .unwrap()
        .save_note("native-note", "Native", "shared rules", 0)
        .unwrap();
    workspace
        .core
        .lock()
        .unwrap()
        .save_entity(
            "notes",
            "native-note",
            serde_json::json!({"metric":0.0,"nested":{"ratio":1.0}}),
            vec![],
            1,
        )
        .unwrap();
    let host = Host::new(
        workspace.clone(),
        "local-owner".into(),
        "http://127.0.0.1:1".into(),
    );
    let peer = Peer {
        id: "legacy".into(),
        url: origin,
        token,
    };
    tick_peer(&host, &peer).await.unwrap();
    tick_peer(&host, &peer).await.unwrap();
    let linux = std::env::var("SHUFANG_LINUX_TEST_ORIGIN").ok();
    if let Some(origin) = &linux {
        let linux_peer = Peer {
            id: "linux".into(),
            url: origin.clone(),
            token: std::env::var("SHUFANG_LINUX_TEST_TOKEN").unwrap(),
        };
        tick_peer(&host, &linux_peer).await.unwrap();
        tick_peer(&host, &linux_peer).await.unwrap();
        tick_peer(&host, &peer).await.unwrap();
        assert_eq!(
            workspace
                .core
                .lock()
                .unwrap()
                .entity("notes", "linux-note")
                .unwrap()
                .value["content"],
            "linux-runtime"
        );
    }
    assert_eq!(
        workspace
            .core
            .lock()
            .unwrap()
            .entity("notes", "legacy-note")
            .unwrap()
            .value["content"],
        "old-v2"
    );
    assert_eq!(
        workspace
            .core
            .lock()
            .unwrap()
            .replication_operations(0, 100)
            .unwrap()
            .len(),
        if linux.is_some() { 5 } else { 4 }
    );
    let hash = std::env::var("SHUFANG_OLD_TEST_BLOB_HASH").unwrap();
    let store = shufang_native::sync_blobs::BlobStore::new(&workspace.root.join("sync-blobs"));
    assert!(store.has(&hash).unwrap());
}
