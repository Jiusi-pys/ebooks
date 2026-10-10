use serde_json::json;
use shufang_native::workspace::Workspace;
#[test]
fn removing_download_requires_verified_remote_bytes_and_keeps_entities() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open(&dir.path().join("library.sqlite"), "test", "test").unwrap();
    let source = dir.path().join("source.txt");
    let parsed = dir.path().join("parsed.json");
    std::fs::write(&source, "offline").unwrap();
    std::fs::write(&parsed,json!({"title":"Offline","author":"","format":"txt","chapters":[{"id":"c","title":"C","paragraphs":["offline"]}],"progress":{"chapterId":"c","ratio":0}}).to_string()).unwrap();
    let book = ws
        .execute("importParsed", json!({"path":source,"parsedPath":parsed}))
        .unwrap();
    let id = book["value"]["id"].as_str().unwrap();
    assert_eq!(
        ws.execute("removeDownload", json!({"id":id})).unwrap_err(),
        "download_has_no_remote_receipt"
    );
    let manifest = ws.core.lock().unwrap().book_source(id).unwrap();
    let before = ws.execute("changes", json!({"after":0})).unwrap();
    ws.core
        .lock()
        .unwrap()
        .set_local_value(
            &format!("file:remote:{}", manifest.sha256),
            0,
            &json!({"sha256":manifest.sha256,"size":manifest.size}),
        )
        .unwrap();
    let path = ws.book_file(id).unwrap();
    ws.execute("removeDownload", json!({"id":id})).unwrap();
    assert!(!path.exists());
    assert_eq!(ws.execute("changes", json!({"after":0})).unwrap(), before);
    assert_eq!(ws.book_file(id).unwrap_err(), "download_removed");
    assert_eq!(
        ws.execute("list", json!({"kind":"books"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    ws.execute("enableDownload", json!({"id":id})).unwrap();
    assert_eq!(ws.book_file(id).unwrap_err(), "source_not_available");
}
