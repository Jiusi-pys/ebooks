//! Opt-in live HTTPS recovery from an isolated, authenticated MySQL peer.
use shufang_native::workspace::Workspace;
use shufang_service::{
    replication::{tick_peer, Peer},
    Host,
};

#[tokio::test]
#[ignore = "requires a separately restored MySQL peer over real HTTPS"]
async fn restores_operations_and_books_from_public_https_peer() {
    let origin = std::env::var("SHUFANG_HTTPS_TEST_ORIGIN").unwrap();
    let token = std::env::var("SHUFANG_HTTPS_TEST_TOKEN").unwrap();
    let workspace_id = std::env::var("SHUFANG_HTTPS_TEST_WORKSPACE").unwrap();
    let node_id = std::env::var("SHUFANG_HTTPS_TEST_NODE").unwrap();
    let expected_operations: usize = std::env::var("SHUFANG_HTTPS_TEST_MIN_OPERATIONS")
        .unwrap()
        .parse()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let database = match std::env::var("SHUFANG_HTTPS_TEST_LOCAL_DATABASE") {
        Ok(path) => {
            let path = std::path::PathBuf::from(path);
            assert!(path.is_absolute());
            path
        }
        Err(_) => dir.path().join("library.sqlite3"),
    };
    let workspace = Workspace::open(&database, &workspace_id, "windows-https-test").unwrap();
    let host = Host::new(
        workspace.clone(),
        "isolated-owner".into(),
        "http://127.0.0.1:1".into(),
    );
    let peer = Peer {
        id: node_id,
        url: origin,
        token,
    };
    let mut received = 0;
    for _ in 0..2 {
        tick_peer(&host, &peer).await.unwrap();
        received = 0;
        let mut after = 0;
        loop {
            let batch = workspace
                .core
                .lock()
                .unwrap()
                .replication_operations(after, 100)
                .unwrap();
            received += batch.len();
            if let Some(last) = batch.last() {
                after = last.sequence;
            }
            if batch.len() < 100 {
                break;
            }
        }
        if received >= expected_operations {
            break;
        }
    }
    assert!(
        received >= expected_operations,
        "received {received} operations"
    );
    let books = workspace
        .execute("list", serde_json::json!({"kind":"books"}))
        .unwrap();
    assert!(books.as_array().is_some_and(|items| items.len() >= 9));
}
