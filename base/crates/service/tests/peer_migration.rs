use serde_json::json;
use shufang_native::workspace::Workspace;
use shufang_service::{peer_migration, Host};
#[test]
fn legacy_peers_import_once_preserves_private_tokens_and_user_changes() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "workspace", "local").unwrap();
    let host = Host::new(w.clone(), "owner".into(), "http://localhost".into());
    let invalid=json!([{"id":"peer","url":"https://peer.example","token":"public-test-token"},{"id":"local","url":"https://other.example","token":"token"}]).to_string();
    assert!(peer_migration::import(&host, &invalid).is_err());
    assert!(w
        .core
        .lock()
        .unwrap()
        .local_value("sync:config")
        .unwrap()
        .is_none());
    let encoded = json!([{"id":"peer","url":"https://peer.example/","token":"public-test-token"}])
        .to_string();
    peer_migration::import(&host, &encoded).unwrap();
    let public = shufang_native::sync_config::public_config(&w).unwrap();
    assert!(!public.to_string().contains("public-test-token"));
    assert_eq!(
        shufang_native::sync_config::configured_peers(&w).unwrap(),
        vec![(
            "peer".into(),
            "https://peer.example".into(),
            "public-test-token".into()
        )]
    );
    shufang_native::sync_config::pause(&w, &json!({"expected":public["revision"],"paused":true}))
        .unwrap();
    peer_migration::import(&host, &encoded).unwrap();
    assert_eq!(
        shufang_native::sync_config::public_config(&w).unwrap()["paused"],
        true
    );
    assert!(peer_migration::import(&host, "[]").is_err());
}
