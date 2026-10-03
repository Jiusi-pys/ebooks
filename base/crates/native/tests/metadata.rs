use serde_json::json;
#[test]
#[ignore = "explicit network acceptance against Open Library"]
fn live_metadata_lookup_uses_native_job() {
    let dir = tempfile::tempdir().unwrap();
    let w = shufang_native::workspace::Workspace::open(&dir.path().join("db"), "lookup", "windows")
        .unwrap();
    let started = w
        .execute("lookupMetadata", json!({"query":"isbn:9780140328721"}))
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        assert!(std::time::Instant::now() < deadline);
        let job = w.execute("job", json!({"id":started["job"]})).unwrap();
        if job["status"] != "running" {
            assert_eq!(job["status"], "completed", "{job}");
            assert!(!job["result"].as_array().unwrap().is_empty());
            println!("LIVE metadata {}", job["result"][0]);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
#[test]
fn automatic_metadata_is_bounded_and_normalized_to_shared_format() {
    let result=shufang_native::metadata::normalize(&json!({"docs":[{"key":"/works/OL1W","title":"书名","author_name":["作者"],"publisher":["出版社"],"first_publish_year":2020,"language":["eng"],"isbn":["9781234567890"],"subject":["Reading"]}]})).unwrap();
    assert_eq!(result[0]["metadata"]["version"], 1);
    assert_eq!(result[0]["author"], "作者");
    assert_eq!(result[0]["metadata"]["publishedDate"], "2020");
    assert_eq!(result[0]["metadata"]["identifiers"][0]["scheme"], "ISBN");
    assert!(shufang_native::metadata::normalize(&json!({"error":"bad"})).is_err());
}
#[test]
fn changing_book_invalidates_digest_atomically() {
    use serde_json::json;
    use shufang_native::workspace::Workspace;
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    w.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"old","author":"","format":"unknown","contentHash":"hash","chapters":[{"id":"c","title":"c","paragraphs":["text"]}]}})).unwrap();
    w.core
        .lock()
        .unwrap()
        .set_local_value("digest:hash", 0, &json!({"version":1,"content":"summary"}))
        .unwrap();
    assert!(w
        .execute(
            "save",
            json!({"kind":"books","id":"b","expected":0,"patch":{"title":"conflict"}})
        )
        .is_err());
    assert!(w
        .core
        .lock()
        .unwrap()
        .local_value("digest:hash")
        .unwrap()
        .unwrap()
        .1
        .get("invalidated")
        .is_none());
    w.execute(
        "save",
        json!({"kind":"books","id":"b","expected":1,"patch":{"title":"new"}}),
    )
    .unwrap();
    assert_eq!(
        w.core
            .lock()
            .unwrap()
            .local_value("digest:hash")
            .unwrap()
            .unwrap()
            .1["invalidated"],
        true
    );
}
