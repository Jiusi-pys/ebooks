use serde_json::json;
use shufang_native::workspace::Workspace;

#[test]
fn peer_url_allows_a_safe_https_proxy_prefix() {
    assert!(shufang_native::sync_config::validate_url(
        "https://us.jiusi.org/__mcp_candidate_20261005__/"
    )
    .is_ok());
    assert!(
        shufang_native::sync_config::validate_url("https://us.jiusi.org/%2e%2e/private").is_err()
    );
}
#[test]
#[cfg(windows)]
fn peer_credentials_are_private_and_config_revisions_are_checked() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "a").unwrap();
    assert!(w
        .execute(
            "saveSyncPeer",
            json!({"expected":0,"id":"b","url":"http://remote.invalid","token":"secret"})
        )
        .is_err());
    w.execute("saveSyncPeer",json!({"expected":0,"id":"b","url":"https://books.example.test","token":"test-private-sync-token"})).unwrap();
    let config = w.execute("syncConfig", json!({})).unwrap();
    assert_eq!(config["revision"], 1);
    assert!(!config.to_string().contains("test-private-sync-token"));
    let stored = w
        .core
        .lock()
        .unwrap()
        .local_value("sync:config")
        .unwrap()
        .unwrap()
        .1;
    assert!(!stored.to_string().contains("test-private-sync-token"));
    assert!(w
        .execute(
            "saveSyncPeer",
            json!({"expected":0,"id":"b","url":"https://books.example.test","token":"replacement"})
        )
        .is_err());
    assert!(w
        .execute(
            "saveSyncPeer",
            json!({"expected":1,"id":"b","url":"https://other.example.test","token":""})
        )
        .is_err());
    assert_eq!(w.core.lock().unwrap().pending().unwrap().len(), 0);
    w.execute("pauseSync", json!({"expected":1,"paused":true}))
        .unwrap();
    assert_eq!(w.execute("syncConfig", json!({})).unwrap()["paused"], true);
}

#[test]
fn remove_and_manual_request_are_local_revision_checked_operations() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "a").unwrap();
    w.execute(
        "saveSyncPeer",
        json!({"expected":0,"id":"b","url":"https://books.example.test","tokenEnvironment":"SHUFANG_TEST_SYNC_TOKEN"}),
    )
    .unwrap();
    assert!(w.execute("requestSync", json!({})).is_err());
    w.execute("pauseSync", json!({"expected":1,"paused":false}))
        .unwrap();
    w.execute("requestSync", json!({})).unwrap();
    assert_eq!(w.execute("syncStatus", json!({})).unwrap()["requested"], 1);
    assert!(w
        .execute("removeSyncPeer", json!({"expected":1,"id":"b"}))
        .is_err());
    w.execute("removeSyncPeer", json!({"expected":2,"id":"b"}))
        .unwrap();
    assert_eq!(
        w.execute("syncConfig", json!({})).unwrap()["peers"],
        json!([])
    );
    assert!(w.execute("requestSync", json!({})).is_err());
    assert_eq!(w.core.lock().unwrap().pending().unwrap().len(), 0);
}

#[test]
fn external_environment_credentials_are_referenced_not_copied_or_replicated() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "a").unwrap();
    let name = format!(
        "SHUFANG_SYNC_TEST_{}",
        uuid::Uuid::new_v4().simple().to_string().to_uppercase()
    );
    std::env::set_var(&name, "private-environment-token");
    w.execute(
        "saveSyncPeer",
        json!({"expected":0,"id":"b","url":"https://books.example.test","tokenEnvironment":name}),
    )
    .unwrap();
    w.execute("pauseSync", json!({"expected":1,"paused":false}))
        .unwrap();
    let peers = shufang_native::sync_config::configured_peers(&w).unwrap();
    assert_eq!(peers[0].2, "private-environment-token");
    assert!(!w
        .execute("syncConfig", json!({}))
        .unwrap()
        .to_string()
        .contains("private-environment-token"));
    assert!(!dir.path().join("credentials").exists());
    assert_eq!(w.core.lock().unwrap().pending().unwrap().len(), 0);
    std::env::remove_var(&name);
    assert!(shufang_native::sync_config::configured_peers(&w).is_err());
    assert!(w.execute("saveSyncPeer",json!({"expected":2,"id":"c","url":"https://books.example.test","tokenEnvironment":"BAD-NAME"})).is_err());
}
