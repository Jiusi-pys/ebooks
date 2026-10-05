#![cfg(feature = "server-mysql")]
use serde_json::json;
use shufang_native::workspace::Workspace;
#[test]
#[ignore = "requires isolated migrated MySQL"]
fn mysql_version_single_record_restore_and_manual_deletion() {
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").unwrap();
    let directory = tempfile::tempdir().unwrap();
    let identity = format!("versions-{}", uuid::Uuid::new_v4());
    let workspace = Workspace::open_mysql(
        &directory.path().join("live/library.mysql"),
        &url,
        &identity,
        "node",
        false,
    )
    .unwrap();
    std::fs::create_dir_all(workspace.root.join("auth")).unwrap();
    std::fs::write(workspace.root.join("auth/session-secret"), "test-auth-key").unwrap();
    workspace.execute("save",json!({"kind":"notes","id":"note","expected":0,"patch":{"title":"Original","content":"Original"}})).unwrap();
    let version = workspace.execute("createVersion", json!({})).unwrap();
    workspace.execute("save",json!({"kind":"notes","id":"note","expected":1,"patch":{"title":"Changed","content":"Changed"}})).unwrap();
    workspace.execute("restoreVersionEntity",json!({"version":version["id"],"kind":"notes","id":"note","operationId":"restore-note"})).unwrap();
    assert_eq!(
        workspace
            .execute("get", json!({"kind":"notes","id":"note"}))
            .unwrap()["value"]["content"],
        "Original"
    );
    assert!(workspace
        .execute("listVersions", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == version["id"]));
    workspace
        .execute("deleteVersion", json!({"id":version["id"]}))
        .unwrap();
    assert!(workspace
        .execute("listVersions", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
