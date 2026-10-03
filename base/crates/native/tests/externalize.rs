use shufang_application::externalize::{hydrate_fields, prepare_fields};
use shufang_domain::lossless_json::Json;
use shufang_native::sync_blobs::BlobStore;
#[test]
fn workspace_externalizes_before_operation_commit_and_reads_hydrated_values_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.sqlite");
    let workspace = shufang_native::workspace::Workspace::open(&path, "w", "native").unwrap();
    let content = "大".repeat(100000);
    let result = workspace
        .core
        .lock()
        .unwrap()
        .save_note("n", "Title", &content, 0)
        .unwrap();
    assert_eq!(result["note"]["content"], content);
    let pending = workspace.core.lock().unwrap().pending().unwrap();
    assert!(pending[0].patch["content"]["$blob"].is_object());
    let original = pending[0].clone();
    drop(workspace);
    let workspace = shufang_native::workspace::Workspace::open(&path, "w", "native").unwrap();
    assert_eq!(
        workspace
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        content
    );
    assert_eq!(
        workspace.core.lock().unwrap().pending().unwrap()[0],
        original
    );
    let hash = original.patch["content"]["$blob"]["sha256"]
        .as_str()
        .unwrap();
    let object = BlobStore::new(&dir.path().join("sync-blobs"))
        .path(hash)
        .unwrap();
    std::fs::write(&object, b"corrupt").unwrap();
    assert!(workspace.core.lock().unwrap().entity("notes", "n").is_err());
}
#[test]
fn disk_field_objects_are_lossless_hydratable_and_corruption_is_repairable() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = BlobStore::new(dir.path());
    let patch = Json::parse(&format!(
        r#"{{"content":"{}\ud800","\udfff":{{"title":"\udfff"}}}}"#,
        "x".repeat(2 * 1024 * 1024)
    ))
    .unwrap();
    let prepared = prepare_fields(&patch, &mut store).unwrap();
    assert_eq!(hydrate_fields(&prepared, &store).unwrap(), patch);
    let hash = String::from_utf16(
        prepared
            .get("content")
            .unwrap()
            .to_owned()
            .get("$blob")
            .unwrap()
            .to_owned()
            .get("sha256")
            .unwrap()
            .to_owned()
            .string_units()
            .unwrap(),
    )
    .unwrap();
    let path = store.path(&hash).unwrap();
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(hydrate_fields(&prepared, &store).is_err());
    let repaired = prepare_fields(&patch, &mut store).unwrap();
    assert_eq!(hydrate_fields(&repaired, &store).unwrap(), patch);
    std::fs::remove_file(path).unwrap();
    assert_eq!(
        hydrate_fields(&prepared, &store).unwrap_err(),
        "sync_field_pending"
    );
}
